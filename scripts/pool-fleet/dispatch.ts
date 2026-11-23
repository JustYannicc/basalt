import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Option, Result, Schema } from "effect";
import type { PoolAccess } from "../pool-acceptance/types.ts";
import type { ModelAuth, PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { dependenciesFromEnvironment, dispatchInput } from "./environment.ts";
import { rootServes, runFleetAcceptance } from "./accept.ts";
import { poolWorkerName, type CloudflareAccess } from "./cloudflare.ts";
import {
  inspectController,
  inspectFleet,
  shortHash,
  takeBookmark,
  UsageRollup,
  type ControllerAccess,
} from "./controller.ts";
import { crashReadyCell } from "./crash-cell.ts";
import { readEnd, type RuntimeEnd } from "../../src/pool/runtime-slots/container-end.ts";
import {
  readFailure,
  readSuspect,
  type FleetFailureRead,
} from "../../src/pool/runtime-fleet/failure-record.ts";
import { describeError, FleetLaneRefused, redact, refuse } from "./errors.ts";
import { configureFleet, disableFleet, waitForReadyCell } from "./operations.ts";

export const modes = [
  "inspect",
  "configure-and-accept",
  "disable",
  "accept",
  "crash-cell",
  "bookmark",
] as const;
type Mode = (typeof modes)[number];
const goPattern = /^coordinator-20\d\d-[A-Za-z0-9-]{1,96}$/u;

export interface DispatchInput {
  mode: string;
  go: string;
  active?: string;
  ref: string;
  event: string;
}
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
/** One failed read or call, as closed values: where, why, the round trip and the lease left. */
const readSummary = (read: FleetFailureRead) => ({
  at: iso(read.at),
  step: read.step,
  cause: read.cause,
  roundTripMs: read.roundTripMs ?? null,
  leaseLeftMs: read.leaseLeftMs ?? null,
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
      }
    : null,
  inForce: fleet.inForce ?? null,
  notInForce: fleet.notInForce ?? null,
  rows: fleet.resources.map((row) => ({
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
      ["configure-and-accept", "disable", "crash-cell", "bookmark"].includes(mode) &&
      !goPattern.test(input.go)
    )
      return yield* Effect.fail(
        refuse(
          "coordinator-go-missing",
          `mode ${mode} changes production and needs a go matching ${goPattern.source}.`,
          "Ask the coordinator for a literal GO and pass it as the go input.",
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
    // Signing uses this checkout's generated code (git HEAD at prepare time); say so when it is stale.
    const probe = yield* Effect.result(call(() => inspectController(access)));
    if (Result.isFailure(probe))
      return yield* Effect.fail(
        /slot_identity/u.test(describeError(probe.failure))
          ? refuse(
              "controller-code-mismatch",
              `The controller refused inspect signed for candidate ${access.code.candidate}; the live PoolWorker runs code built from another commit.`,
              "Dispatch from the main commit the last release deployed, or release main first.",
            )
          : probe.failure,
      );
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
      return { ...evidence, acceptance, ...(yield* read()) };
    }
    if (mode === "disable") return { ...evidence, disable: yield* disableFleet(access, input.go) };
    if (mode === "bookmark")
      return { ...evidence, bookmark: yield* call(() => takeBookmark(access)) };
    const acceptance = yield* needAcceptance(deps);
    const accept = () =>
      call(() =>
        runFleetAcceptance({
          ...acceptance,
          controller: () => inspectController(access),
          fleet: () => inspectFleet(access),
          log: deps.log,
        }),
      );
    if (mode === "accept") return { ...evidence, acceptance: yield* accept() };
    if (mode === "crash-cell") {
      const catalog = yield* call(() => acceptance.client.modelCatalog(acceptance.credential));
      const model = acceptance.model ?? (catalog.ids.length === 1 ? catalog.ids[0]! : undefined);
      if (!model)
        return yield* Effect.fail(
          refuse(
            "model-ambiguous",
            `/v1/models lists ${catalog.ids.length} models and POOL_ACCEPTANCE_MODEL is unset.`,
            "Set the acceptance model variable.",
          ),
        );
      return {
        ...evidence,
        crash: yield* crashReadyCell({
          controller: access,
          go: input.go,
          operator: "pool-fleet",
          // Every fifth request is a streamed turn, so inference is proven, not only routing.
          request: (index) =>
            index % 5 === 0
              ? acceptance.client.sendTurn(acceptance.credential, model, {
                  id: crypto.randomUUID(),
                  expectedRecords: 1,
                })
              : acceptance.client.modelCatalog(acceptance.credential),
          sleep: deps.sleep,
          now: deps.now,
        }),
      };
    }
    // configure-and-accept stands alone: any failure after a send disables, then proves the root.
    const attempt = yield* Effect.result(
      Effect.gen(function* () {
        const configured = yield* configureFleet({
          cloudflare: deps.cloudflare,
          controller: access,
          go: input.go,
          active: input.active as "blue" | "green" | undefined,
        });
        evidence.configure = configured;
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
        const root = yield* call(() =>
          rootServes({ ...acceptance, controller: () => inspectController(access), log: deps.log }),
        );
        return { disabled, root };
      }),
    );
    return yield* Effect.fail({
      cause,
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
  const detail =
    failure !== null && typeof failure === "object" && "cause" in failure && "rollback" in failure
      ? failure
      : { cause: describeError(failure) };
  return redact({ mode: input.mode, go: input.go, startedAt, ok: false, ...detail }, secrets);
}

export function stepSummary(result: Awaited<ReturnType<typeof runPoolFleet>>) {
  const lines = [
    `## Pool fleet: ${modes.includes(result.mode as Mode) ? result.mode : "invalid mode"}`,
    "",
    `- GO: \`${goPattern.test(result.go) ? result.go : "none"}\``,
    `- Outcome: ${result.ok ? "passed" : "**failed**"}`,
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
  let ok = false;
  try {
    const result = await runPoolFleet(dispatchInput(env), await dependenciesFromEnvironment(env));
    const output = env.POOL_FLEET_OUTPUT_DIRECTORY ?? "";
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, stepSummary(result));
    process.stdout.write(`ok=${result.ok}\n`);
    ok = result.ok;
  } catch {
    process.stderr.write("Pool fleet result unavailable.\n");
  }
  if (!ok) process.exitCode = 1;
}
