import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Result, Schema } from "effect";
import type { PoolAccess } from "../pool-acceptance/types.ts";
import type { ModelAuth, PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { dependenciesFromEnvironment, dispatchInput } from "./environment.ts";
import { crashTrafficAccepted, quotaRefused, rootServes, runFleetAcceptance } from "./accept.ts";
import { capReached, isCapReached, OwnTraffic, turnBudgets } from "./own-traffic.ts";
import { poolWorkerName, type CloudflareAccess } from "./cloudflare.ts";
import {
  inspectController,
  inspectFleet,
  shortHash,
  takeBookmark,
  UsageRollup,
  CaptureHours,
  type ControllerAccess,
} from "./controller.ts";
import { crashReadyCell } from "./crash-cell.ts";
import { readEnd, type RuntimeEnd } from "../../src/pool/runtime-slots/container-end.ts";
import {
  readFailure,
  readSuspect,
  type FleetFailureRead,
} from "../../src/pool/runtime-fleet/failure-record.ts";
import { decodeReadySignals } from "../../src/pool/runtime-ready-signals.ts";
import { RecoveryRecord } from "../../src/pool/runtime-slots/recovery-record.ts";
import { describeError, FleetLaneRefused, redact, refuse, workerAnswer } from "./errors.ts";
import {
  checkRetireRow,
  codeMismatch,
  configureFleet,
  configureOperationId,
  disableFleet,
  handoverLeft,
  refusedCode,
  retireRow,
  step,
  untilSettled,
  waitForReadyCell,
  type SettleWait,
} from "./operations.ts";

export const modes = [
  "inspect",
  "configure-and-accept",
  "disable",
  "accept",
  "crash-cell",
  "bookmark",
  "retire-row",
  "retire-check",
] as const;
type Mode = (typeof modes)[number];
/** A coordinator GO; the release re-commits the fleet only under one (`scripts/release/fleet-recommit.ts`). */
export const goPattern = /^coordinator-20\d\d-[A-Za-z0-9-]{1,96}$/u;

export interface DispatchInput {
  mode: string;
  go: string;
  active?: string;
  /** retire-row and retire-check only: the row's key from the lane's inspect. */
  key?: string;
  /** configure-and-accept only: the growth target to configure, 1 to 100,000. */
  targetActive?: string;
  /** configure-and-accept from a release only: a fleet that is off stays off, and nothing is sent. */
  enabledOnly?: boolean;
  ref: string;
  event: string;
}
/** The acceptance device: its assertion signs every model call and reads back its own usage. */
export interface FleetAcceptance {
  client: PoolAcceptanceClient;
  credential: ModelAuth;
  model?: string;
  /** Present only for a dedicated acceptance pool; absent, the lane never sends an owner token. */
  access?: PoolAccess;
}
export interface DispatchDependencies {
  cloudflare: CloudflareAccess;
  controller: (worker: string) => ControllerAccess;
  /** Or why the lane has none: only modes that send model calls need it. */
  acceptance: FleetAcceptance | FleetLaneRefused;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  readyBoundMs?: number;
}

const call = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });

/** How a runtime container ended, as closed values: exit code, cause, and whether we stopped it. */
const endSummary = (end: RuntimeEnd) => ({
  at: new Date(end.at).toISOString(),
  exitCode: end.exitCode,
  cause: end.cause,
  seen: end.seen,
  stopSent: end.stopSent === true,
});
/** A kept end as closed values, or nothing when this lane can't read it. */
const keptEnd = (value: unknown, id: (value: Record<string, unknown>) => unknown) => {
  if (typeof value !== "object" || value === null) return null;
  const kept = value as Record<string, unknown>;
  const end = readEnd(kept.end);
  const key = id(kept);
  return end && typeof key === "string" ? { key: shortHash(key), ...endSummary(end) } : null;
};

/** A recorded time, or nothing when it is out of range: another version's value never fails the lane. */
const iso = (at: number) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
/** A word from the Worker's closed vocabulary; anything else, from any version, prints as other. */
const word = (value: string) => (/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value) ? value : "other");
/** The root's last recovery: when detected and ready, its rounds, and each kept round's refusal. */
const recoverySummary = (value: unknown) =>
  Option.getOrNull(
    Option.map(Schema.decodeUnknownOption(RecoveryRecord)(value), (record) => ({
      key: shortHash(record.boot),
      detectedAt: iso(record.detectedAt),
      readyAt: record.readyAt === null ? null : iso(record.readyAt),
      rounds: record.rounds,
      refusals: record.refusals.map((refusal) => ({
        round: refusal.round,
        at: iso(refusal.at),
        reason: word(refusal.reason),
        step: refusal.step === undefined ? null : word(refusal.step),
        class: word(refusal.class),
        provider: refusal.provider === undefined ? null : word(refusal.provider),
        read: typeof refusal.read === "string" ? word(refusal.read) : null,
        status:
          refusal.status !== undefined && Number.isSafeInteger(refusal.status)
            ? refusal.status
            : null,
        field: refusal.field === undefined ? null : word(refusal.field),
        state: refusal.state === undefined ? null : word(refusal.state),
      })),
    })),
  );
/** The cell's own readiness record behind a read, decoded again so only closed values print. */
const readySummary = (value: unknown) => {
  const ready = decodeReadySignals(value);
  return ready
    ? {
        lastLapse: ready.lastLapse ?? null,
        lastFlip: ready.lastFlip ?? null,
        lastStall: ready.lastStall ?? null,
        lapses: ready.lapses ?? null,
        flips: ready.flips ?? null,
        stalls: ready.stalls ?? null,
      }
    : null;
};
/** One failed read or call, as closed values: where, why, the round trip and the lease left. */
const readSummary = (read: FleetFailureRead) => ({
  at: iso(read.at),
  step: read.step,
  cause: read.cause,
  roundTripMs: read.roundTripMs ?? null,
  leaseLeftMs: read.leaseLeftMs ?? null,
  ready: readySummary(read.ready),
});
const suspectSummary = (value: unknown) => {
  const suspect = readSuspect(value);
  return suspect
    ? {
        since: iso(suspect.since),
        failed: suspect.failed ? readSummary(suspect.failed) : null,
        reads: suspect.reads.map(readSummary),
        // How many pools' current policy the cell still lacks; it serves none until this is 0.
        policyOwed: suspect.policyOwed?.length ?? 0,
      }
    : null;
};
const failureSummary = (value: unknown) => {
  const failure = readFailure(value);
  return failure
    ? { path: failure.path, rule: failure.rule, reads: failure.reads.map(readSummary) }
    : null;
};
/** A cell that left: how its container ended, if recorded, and for a quarantine why. */
const leftSummary = (value: unknown) => {
  if (typeof value !== "object" || value === null) return null;
  const kept = value as Record<string, unknown>;
  if (typeof kept.slotId !== "string") return null;
  const end = readEnd(kept.end);
  return {
    key: shortHash(kept.slotId),
    end: end ? endSummary(end) : null,
    left: kept.left === "quarantined" || kept.left === "retired" ? kept.left : null,
    reason: typeof kept.reason === "string" ? kept.reason : null,
    failure: failureSummary(kept.failure),
  };
};

const fleetSummary = (fleet: Awaited<ReturnType<typeof inspectFleet>>) => ({
  permission: fleet.permission
    ? {
        operationId: fleet.permission.operationId,
        digest: fleet.permission.digest,
        enabled: fleet.permission.enabled,
        revision: fleet.permission.configuration.revision,
        active: fleet.permission.configuration.active,
        targetActive: fleet.permission.configuration.targetActive,
        maximum: fleet.permission.configuration.maximum,
      }
    : null,
  inForce: fleet.inForce ?? null,
  notInForce: fleet.notInForce ?? null,
  rows: fleet.resources.map((row) => ({
    // The same short hash its recent end carries once it leaves, so the two can be matched.
    key: shortHash(row.target.slotId),
    ordinal: row.target.homePeerOrdinal ?? null,
    phase: row.phase,
    active: row.active,
    reason: row.reason ?? null,
    inPhaseMs: row.inPhaseMs ?? null,
    applicationId: row.target.applicationId,
    boot: row.identity ? shortHash(row.identity.bootId) : null,
    // Its reads since the last good one were not good: it takes no new call meanwhile.
    suspect: suspectSummary(row.suspect),
    failure: failureSummary(row.failure),
  })),
  bindings: fleet.bindings,
  // Each cell that left, newest first; the key is its slot's short hash.
  recentEnds: (fleet.recentEnds ?? []).flatMap((value) => {
    const kept = leftSummary(value);
    return kept ? [kept] : [];
  }),
});

const needAcceptance = ({ acceptance }: DispatchDependencies) =>
  acceptance instanceof FleetLaneRefused ? Effect.fail(acceptance) : Effect.succeed(acceptance);

/**
 * The GO is the gate. A model socket can outlive the isolate that took its lease, so the cell's own
 * read of its open connections is said plainly whenever it doesn't show the cell idle.
 */
const connectionWarning = (connections: number | null | undefined) =>
  connections === 0
    ? null
    : typeof connections === "number"
      ? `${connections} connections are open on this cell; the override may cut them`
      : "the connection read failed; nothing proves this cell is idle";

const program = (input: DispatchInput, deps: DispatchDependencies) =>
  Effect.gen(function* () {
    if (!modes.includes(input.mode as Mode))
      return yield* Effect.fail(
        refuse("mode-invalid", `mode must be one of ${modes.join(", ")}.`, "Pick a listed mode."),
      );
    const mode = input.mode as Mode;
    if (input.ref !== "refs/heads/main" || input.event !== "workflow_dispatch")
      return yield* Effect.fail(
        refuse(
          "dispatch-origin",
          "The lane runs only as workflow_dispatch on refs/heads/main.",
          "Dispatch the workflow from main.",
        ),
      );
    if (
      ["configure-and-accept", "disable", "crash-cell", "bookmark", "retire-row"].includes(mode) &&
      !goPattern.test(input.go)
    )
      return yield* Effect.fail(
        refuse(
          "coordinator-go-missing",
          `mode ${mode} changes production and needs a go matching ${goPattern.source}.`,
          "Ask the coordinator for a literal GO and pass it as the go input.",
        ),
      );
    // The bounds src/pool/runtime-fleet/configuration.ts accepts for targetActive.
    const targetActive = input.targetActive ? Number(input.targetActive) : undefined;
    if (
      input.targetActive &&
      (mode !== "configure-and-accept" ||
        !/^[1-9][0-9]{0,5}$/u.test(input.targetActive) ||
        targetActive! > 100_000)
    )
      return yield* Effect.fail(
        refuse(
          "target-active-invalid",
          `target-active "${input.targetActive.slice(0, 12)}" must be an integer from 1 to 100000, and only configure-and-accept takes it.`,
          "Leave it empty to keep the configured value, or pass one in range with configure-and-accept.",
        ),
      );
    if (input.active && input.active !== "blue" && input.active !== "green")
      return yield* Effect.fail(
        refuse(
          "active-invalid",
          "active must be blue or green.",
          "Leave it empty for the default.",
        ),
      );
    const worker = yield* poolWorkerName(deps.cloudflare);
    const access = deps.controller(worker);
    const evidence: Record<string, unknown> = { controllerCode: access.code };
    // inspect and retire-check send nothing, so their probe waits out the controller's code handover
    // too, but only for what's left of it since the PoolWorker's latest deployment: the lane holds
    // the release lock, and a wait no handover can end would only hold it. Unread waits for nothing.
    const readOnly = mode === "inspect" || mode === "retire-check";
    const window = readOnly ? yield* handoverLeft(deps.cloudflare, worker, deps.now) : undefined;
    // configure-and-accept may run right after a deploy: every read before its send shares one wait
    // for the controller's code handover.
    const settle = { clock: { sleep: deps.sleep, now: deps.now }, from: deps.now() };
    const probeSettle =
      mode === "configure-and-accept"
        ? settle
        : typeof window === "number" && window > 0
          ? { ...settle, boundMs: window * 1000 }
          : undefined;
    const waits: SettleWait[] = [];
    // Signing uses this checkout's generated code (git HEAD at prepare time); say so when it is stale.
    const probe = yield* Effect.result(
      probeSettle
        ? untilSettled(
            probeSettle,
            access,
            step("probe", () => inspectController(access)).pipe(Effect.map((value) => ({ value }))),
            readOnly ? (wait) => waits.push(wait) : undefined,
          )
        : call(() => inspectController(access)),
    );
    if (readOnly && (waits.length || Result.isFailure(probe))) {
      const probeWait = {
        window,
        seconds: Math.round((deps.now() - settle.from) / 1000),
        reads: waits.length + 1,
        for: waits,
      };
      evidence.probeWait = probeWait;
      deps.log(
        `probe_wait window=${window} seconds=${probeWait.seconds} reads=${probeWait.reads} for=${waits.join(",")}`,
      );
    }
    // Once the probe logged its wait, every failure of the run keeps it.
    const keepingWait = <A, E>(work: Effect.Effect<A, E>) =>
      "probeWait" in evidence
        ? work.pipe(Effect.mapError((failure) => ({ cause: describeError(failure), evidence })))
        : work;
    if (Result.isFailure(probe)) {
      const failure = refusedCode(workerAnswer(probe.failure))
        ? codeMismatch(access)
        : probe.failure;
      return yield* keepingWait(Effect.fail(failure));
    }
    const read = () =>
      Effect.gen(function* () {
        const view = yield* call(() => inspectController(access));
        const fleet = yield* call(() => inspectFleet(access));
        return {
          selection: view.selection?.active.identity
            ? {
                epoch: view.selection.epoch,
                primaryBoot: shortHash(view.selection.active.identity.bootId),
              }
            : null,
          policyDigest: view.digest,
          // How the primary a recovery last replaced had ended; the key is its boot's short hash.
          lastEnd: keptEnd(view.lastEnd, (entry) =>
            typeof entry.previous === "object" && entry.previous !== null
              ? (entry.previous as Record<string, unknown>).bootId
              : undefined,
          ),
          // The root's last recovery; its key is the restarted boot's short hash, as lastEnd's.
          lastRecovery: recoverySummary(view.lastRecovery),
          // The pool's expiry alert refused by Sentry (spent quota, a rate limit) or, with no
          // lastStatus, never reaching it.
          alertDelivery: view.alertDelivery
            ? {
                refusedSince: new Date(view.alertDelivery.refusedSince).toISOString(),
                lastStatus: view.alertDelivery.lastStatus ?? null,
              }
            : null,
          fleet: fleetSummary(fleet),
          // The pool's own usage rollup backfill: its last tick, stop, pause, the hour that stopped
          // it, pending hours and any stuck pool, by its 16-hex history id only.
          usageRollup: Option.getOrNull(
            Schema.decodeUnknownOption(Schema.NullOr(UsageRollup))(view.usageRollup ?? null),
          ),
          // The pool's own capture-hour counts: the same, and absent on a pool before them.
          captureHours: Option.getOrNull(
            Schema.decodeUnknownOption(Schema.NullOr(CaptureHours))(view.captureHours ?? null),
          ),
        };
      });
    if (mode === "inspect") {
      // Which acceptance the model-call modes would run, by kind alone: never an id.
      const acceptance =
        deps.acceptance instanceof FleetLaneRefused
          ? `refused (${deps.acceptance.reason})`
          : deps.acceptance.access
            ? "full"
            : "device-only (no dedicated acceptance pool)";
      deps.log(`acceptance=${acceptance}`);
      return { ...evidence, acceptance, ...(yield* keepingWait(read())) };
    }
    if (mode === "disable") return { ...evidence, disable: yield* disableFleet(access, input.go) };
    if (mode === "retire-row") {
      const key = input.key ?? "";
      const named = (fleet: ReturnType<typeof fleetSummary>) =>
        fleet.rows.filter((row) => row.key.startsWith(key));
      const before = named((yield* read()).fleet);
      const retired = yield* retireRow(access, input.go, key);
      const warning = connectionWarning(retired.overrode?.connections);
      if (warning) deps.log(`WARNING ${warning}`);
      return { ...evidence, before, retired, warning, after: named((yield* read()).fleet) };
    }
    if (mode === "retire-check") {
      const check = yield* keepingWait(checkRetireRow(access, input.key ?? ""));
      deps.log(
        check.wouldProceed
          ? "retire-row would proceed"
          : `retire-row would be refused: ${check.refusal}`,
      );
      deps.log(check.leaseOwner);
      const warning = check.phase === "draining" ? connectionWarning(check.connections) : null;
      if (warning) deps.log(`WARNING ${warning}`);
      return { ...evidence, check, warning };
    }
    if (mode === "bookmark")
      return { ...evidence, bookmark: yield* call(() => takeBookmark(access)) };
    const acceptance = yield* needAcceptance(deps);
    const accept = (rootUsage = false) =>
      call(() =>
        runFleetAcceptance({
          ...acceptance,
          controller: () => inspectController(access),
          fleet: () => inspectFleet(access),
          sleep: deps.sleep,
          log: deps.log,
          rootUsage,
        }),
      );
    // Mode accept changes nothing, so with no cell it still proves the root's usage. Configure-and-
    // accept waits for a ready cell first and keeps requiring one.
    if (mode === "accept") return { ...evidence, acceptance: yield* accept(true) };
    if (mode === "crash-cell") {
      const traffic = new OwnTraffic(
        acceptance.client,
        acceptance.credential,
        turnBudgets.crashCell,
      );
      const catalog = yield* call(() => traffic.catalog());
      const model = acceptance.model ?? (catalog.ids.length === 1 ? catalog.ids[0]! : undefined);
      if (!model)
        return yield* Effect.fail(
          refuse(
            "model-ambiguous",
            `/v1/models lists ${catalog.ids.length} models and POOL_ACCEPTANCE_MODEL is unset.`,
            "Set the acceptance model variable.",
          ),
        );
      // One served turn before anything else: a user at its cap stops the run here, before a kill.
      yield* step("send", () => traffic.turn(model));
      // The killed cell is gone after the crash, so its boot is known only from this read.
      const before = yield* step("inspect", () => inspectFleet(access));
      const crash = yield* crashReadyCell({
        controller: access,
        go: input.go,
        operator: "pool-fleet",
        // Every fifth request is a streamed turn, so inference is proven, not only routing.
        // Past the turn budget, or once the user's cap answers, it reads the catalog instead:
        // the cap is the user's, so its turn is no failed request.
        request: (index) =>
          index % 5 === 0 && traffic.turnsLeft(model) > 0
            ? traffic.turn(model).catch((error: unknown) => {
                if (isCapReached(error)) return traffic.catalog();
                throw error;
              })
            : traffic.catalog(),
        halted: () => (traffic.capped ? capReached() : undefined),
        sleep: deps.sleep,
        now: deps.now,
      });
      if (traffic.capped) return yield* capReached();
      if (crash.status !== "proven") return { ...evidence, crash };
      const ownTraffic = yield* step("inspect_after", () =>
        crashTrafficAccepted({
          traffic,
          before,
          controller: () => inspectController(access),
          fleet: () => inspectFleet(access),
          sleep: deps.sleep,
        }),
      );
      return { ...evidence, crash: { ...crash, ownTraffic } };
    }
    // A rerun under the same GO only inspects, so another target would silently not apply. It is
    // refused here, before anything is sent.
    if (targetActive !== undefined) {
      const retained = (yield* untilSettled(
        settle,
        access,
        step("inspect", () => inspectFleet(access, configureOperationId(input.go))).pipe(
          Effect.map((value) => ({ value })),
        ),
      )).permission;
      if (retained && retained.configuration.targetActive !== targetActive)
        return yield* Effect.fail(
          refuse(
            "target-active-differs",
            `This GO already configured targetActive ${retained.configuration.targetActive}; ${targetActive} was not applied.`,
            "A new target needs a new GO.",
          ),
        );
    }
    // configure-and-accept stands alone: any failure once this run sent or holds a configuration
    // disables, then proves the root. A failure before that leaves a fleet it never touched alone.
    let touched = false;
    const attempt = yield* Effect.result(
      Effect.gen(function* () {
        const configured = yield* configureFleet({
          cloudflare: deps.cloudflare,
          controller: access,
          go: input.go,
          active: input.active as "blue" | "green" | undefined,
          ...(targetActive ? { targetActive } : {}),
          settle,
          sending: () => {
            touched = true;
          },
          ...(input.enabledOnly ? { enabledOnly: true } : {}),
        });
        evidence.configure = configured;
        if (configured.status === "fleet-disabled" || configured.status === "fleet-absent") return;
        touched = true;
        evidence.ready = yield* waitForReadyCell({
          controller: access,
          demand: () => acceptance.client.modelCatalog(acceptance.credential),
          sleep: deps.sleep,
          now: deps.now,
          boundMs: deps.readyBoundMs,
        });
        evidence.acceptance = yield* accept();
      }),
    );
    if (Result.isSuccess(attempt)) return { ...evidence, ...(yield* read()) };
    const cause = describeError(attempt.failure);
    const couldNotTest = isCapReached(attempt.failure);
    if (!touched) {
      deps.log(`configure_and_accept status=failed before any send; the fleet is as it was`);
      return yield* Effect.fail({
        cause,
        couldNotTest,
        rollback: { skipped: "nothing-sent" },
        evidence,
      });
    }
    // Every acceptance model refused for funding: Home's decision from the pool's accounts, which a
    // cell answers as the root would, so the permission stays in force, unproven, and the run fails
    // loudly. A `model_cooldown` refusal can be the cell's own node and disables, as a cell that
    // fails to serve does (accept.ts).
    if (attempt.failure instanceof FleetLaneRefused && attempt.failure.reason === quotaRefused) {
      deps.log(
        `configure_and_accept status=unproven; the acceptance models were refused for funding`,
      );
      return yield* Effect.fail({
        cause,
        rollback: { skipped: "quota-refused: the permission stays in force, unproven" },
        evidence,
      });
    }
    deps.log(`configure_and_accept status=failed; disabling the fleet`);
    const rollback = yield* Effect.result(
      Effect.gen(function* () {
        const disabled = yield* disableFleet(access, input.go).pipe(
          Effect.catch((error) =>
            error instanceof FleetLaneRefused && error.reason === "fleet-record-missing"
              ? Effect.succeed({ status: "nothing-to-disable" as const })
              : Effect.fail(error),
          ),
        );
        // At the user's cap the root's turn would be refused too, and no turn follows the cap.
        if (couldNotTest) return { disabled, root: { status: "not-tested" as const } };
        const root = yield* call(() =>
          rootServes({ ...acceptance, controller: () => inspectController(access), log: deps.log }),
        );
        return { disabled, root };
      }),
    );
    return yield* Effect.fail({
      cause,
      couldNotTest,
      rollback: Result.isSuccess(rollback)
        ? rollback.success
        : { failed: describeError(rollback.failure) },
      evidence,
    });
  });

export async function runPoolFleet(input: DispatchInput, deps: DispatchDependencies) {
  const startedAt = new Date(deps.now()).toISOString();
  const outcome = await Effect.runPromise(Effect.result(program(input, deps)));
  const secrets = [deps.cloudflare.accountId];
  if (Result.isSuccess(outcome))
    return redact(
      { mode: input.mode, go: input.go, startedAt, ok: true, result: outcome.success },
      secrets,
    );
  const failure = outcome.failure;
  // A configure failure carries its rollback and evidence; a probe that waited, its evidence.
  const detail =
    failure !== null &&
    typeof failure === "object" &&
    "cause" in failure &&
    ("rollback" in failure || "evidence" in failure)
      ? failure
      : { cause: describeError(failure), couldNotTest: isCapReached(failure) };
  return redact({ mode: input.mode, go: input.go, startedAt, ok: false, ...detail }, secrets);
}

const couldNotTest = (result: Awaited<ReturnType<typeof runPoolFleet>>) =>
  !result.ok && "couldNotTest" in result && result.couldNotTest === true;

/** Exit 4 matches the release's "could not test": not green, and nothing failed. */
export const fleetExit = (result: Awaited<ReturnType<typeof runPoolFleet>>) =>
  result.ok ? 0 : couldNotTest(result) ? 4 : 1;

export function stepSummary(result: Awaited<ReturnType<typeof runPoolFleet>>) {
  const lines = [
    `## Pool fleet: ${modes.includes(result.mode as Mode) ? result.mode : "invalid mode"}`,
    "",
    `- GO: \`${goPattern.test(result.go) ? result.go : "none"}\``,
    `- Outcome: ${result.ok ? "passed" : couldNotTest(result) ? "**could not test**: the acceptance device's user is at its cap" : "**failed**"}`,
  ];
  const bookmark =
    "result" in result
      ? (result.result as { bookmark?: { at?: unknown } } | undefined)?.bookmark
      : undefined;
  if (bookmark) lines.push(`- Controller storage bookmark taken at ${String(bookmark.at)}`);
  if (!result.ok && "cause" in result) lines.push(`- Cause: ${String(result.cause)}`);
  if (!result.ok && "rollback" in result)
    lines.push(`- Rollback: \`${JSON.stringify(result.rollback)}\``);
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const env = process.env;
  let exit = 1;
  try {
    const result = await runPoolFleet(dispatchInput(env), await dependenciesFromEnvironment(env));
    const output = env.POOL_FLEET_OUTPUT_DIRECTORY ?? "";
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, stepSummary(result));
    process.stdout.write(`ok=${result.ok}\n`);
    exit = fleetExit(result);
  } catch {
    process.stderr.write("Pool fleet result unavailable.\n");
  }
  if (exit) process.exitCode = exit;
}
