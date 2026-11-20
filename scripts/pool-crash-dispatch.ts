import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { runtimeRecoveryPath } from "../src/pool/recovery-approval.ts";
import {
  ControllerCode,
  SlotIdentity,
  SlotRefused,
  SlotTarget,
} from "../src/pool/runtime-slots/contract.ts";
import { decodeRuntimeHandoffCommand } from "../src/pool/runtime-slots/handoff-command.ts";
import { isSigningKey } from "../src/pool/token.ts";
import { runCrashOperator } from "./pool-crash-operator.ts";
import { openPoolOperations, type PoolOperationsTarget } from "./pool-operations.ts";
import { nodePoolOperations } from "./pool-operations-node.ts";
import { BarrierRefusal } from "./pool-fleet/refusal.ts";
import { sendRuntimeCommand } from "./pool-fleet/runtime-command-rpc.ts";
import {
  readReleaseTarget,
  workflowRunLister,
  RunListRefused,
  type ReleaseTarget,
  type RootApplication,
} from "./pool-crash-dispatch-sources.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u));
const ObservePacket = Schema.Struct({ controllerCode: ControllerCode });
const CrashPacket = Schema.Struct({
  controllerCode: ControllerCode,
  identity: SlotIdentity,
  nonce: Name,
  operator: Name,
});
type CrashPacket = typeof CrashPacket.Type;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const observeActions = ["inspect", "fleet-inspect", "active-health", "witness"] as const;
type ObserveAction = (typeof observeActions)[number];
type Connect = PoolOperationsTarget["connect"];

export interface DispatchDependencies {
  listRuns(): Promise<readonly { id: number; displayTitle: string }[]>;
  readTarget(): Promise<ReleaseTarget & { root?: RootApplication }>;
  observe(
    action: ObserveAction,
    controllerCode: ControllerCode,
    target: ReleaseTarget,
    signingKey: string,
    slot?: SlotTarget,
  ): Promise<unknown>;
  /**
   * The root PoolContainer's unsigned recovery status read: identity and boot, never a restart.
   * Only meaningful without a selection; the controller refuses it once one exists.
   */
  rootHealth(target: ReleaseTarget): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  crash(request: {
    packet: CrashPacket & ReleaseTarget;
    mode: "apply" | "inspect";
    signingKey: string;
  }): Promise<{ inspection: boolean; result: unknown }>;
  now(): number;
}

export interface DispatchInput {
  mode: string;
  requestId: string;
  packet: string;
  coordinatorGo: string;
  accountId: string;
  signingKey: string;
  ref: string;
  event: string;
  runId: number;
  runAttempt: string;
}

/** A refusal whose message names the exact field and is safe to publish. */
class DispatchRefusal extends Error {}

function assertGo(go: string) {
  if (!go.trim()) throw new DispatchRefusal("coordinator_go is empty");
  if (/[<>]/u.test(go)) throw new DispatchRefusal("coordinator_go contains a bracket");
  if (/placeholder|replace|pending|example/iu.test(go))
    throw new DispatchRefusal("coordinator_go contains a placeholder");
}

function decodePacket<A>(schema: Schema.Codec<A>, value: unknown, shape: string) {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new DispatchRefusal(`packet must be exactly ${shape}`);
  }
}

function replyResult(reply: unknown, action: string) {
  if (reply === null || typeof reply !== "object" || !("result" in reply))
    throw new DispatchRefusal(`${action} reply has no result`);
  return reply.result;
}

/**
 * The artifact is public on this repository. Raw controller replies can name the account (fleet
 * applications carry it), so its exact value is replaced while every other identity field stays raw
 * for the consumer's field-by-field comparison.
 */
function redactAccount<T>(value: T, accountId: string): T {
  if (!accountId) return value;
  return JSON.parse(
    JSON.stringify(value, (_key, field: unknown) =>
      field === accountId ? "redacted-account" : field,
    ),
  ) as T;
}

// Raw messages from the bridge can name the account or worker; only fixed codes reach a public artifact.
function publicError(error: unknown, phase: string) {
  if (error instanceof DispatchRefusal) return error.message;
  const code =
    error instanceof ControllerRefused
      ? `: runtime-handoff-refused (${error.reason})`
      : error instanceof BarrierRefusal
        ? `: ${error.reason}${error.worker ? ` (${error.worker})` : ""}`
        : error instanceof SlotRefused
          ? `: ${error.reason}`
          : "";
  return `${phase}${code}`;
}

// The controller's durable nonce stays the second guard; this one only decides whether to try.
async function replayed(input: DispatchInput, deps: DispatchDependencies) {
  // A re-run keeps its run id, so any later attempt is itself a replay of this nonce.
  if (input.runAttempt !== "1") return true;
  let runs: Awaited<ReturnType<DispatchDependencies["listRuns"]>>;
  try {
    runs = await deps.listRuns();
  } catch (cause) {
    const status = cause instanceof RunListRefused ? ` (HTTP ${cause.status})` : "";
    throw new DispatchRefusal(`workflow run list unavailable${status}; apply refused`);
  }
  return runs.some((run) => run.id !== input.runId && run.displayTitle.includes(input.requestId));
}

const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);

// Pool, organization and account identifiers reach the public artifact only as fingerprints.
function memberships(rows: unknown) {
  if (!Array.isArray(rows)) return null;
  return rows.map((row) => {
    const value = fields(row);
    return {
      pool: typeof value.pool === "string" ? fingerprint(value.pool) : null,
      organization: typeof value.organization === "string" ? fingerprint(value.organization) : null,
      revision: typeof value.revision === "number" ? value.revision : null,
      expiresAt: typeof value.expiresAt === "number" ? value.expiresAt : null,
      dirty: typeof value.dirty === "boolean" ? value.dirty : null,
      accounts: Array.isArray(value.accounts)
        ? value.accounts.map((account) =>
            typeof account === "string" ? fingerprint(account) : null,
          )
        : null,
    };
  });
}

function membershipState(inspected: unknown, observedAt: number) {
  const value = fields(inspected);
  return {
    observedAt,
    selectionPresent: value.selection !== undefined && value.selection !== null,
    policies: memberships(value.policies),
    denials: memberships(value.denials),
    digest: text(value.digest),
  };
}

const RootHealth = Schema.Struct({
  instanceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  imageHash: Schema.String,
  running: Schema.Boolean,
  ready: Schema.Boolean,
  bootId: Schema.optional(Schema.String),
});

type Step<T> = { ok: true; value: T } | { ok: false; refused?: string; error?: string };
async function step<T>(read: () => Promise<T>, phase: string): Promise<Step<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (cause) {
    return cause instanceof ControllerRefused
      ? { ok: false, refused: cause.reason }
      : { ok: false, error: publicError(cause, phase) };
  }
}

// Only the active target is read, so a newer controller's other selection fields never hide it.
const Selected = Schema.Struct({
  selection: Schema.Struct({ active: Schema.Struct({ target: SlotTarget }) }),
});

/** The selected primary's target, or undefined when no selection exists. */
function selectedTarget(inspected: unknown): Step<SlotTarget> | undefined {
  const selection = fields(inspected).selection;
  if (selection === undefined || selection === null) return undefined;
  try {
    return {
      ok: true,
      value: Schema.decodeUnknownSync(Selected)(inspected).selection.active.target,
    };
  } catch {
    return { ok: false, error: "selection active target unreadable; witness not sent" };
  }
}

/** Without a selection the root container is the primary; its legacy slot is named from its health read. */
async function legacyPrimary(input: {
  root: RootApplication | undefined;
  target: ReleaseTarget;
  deps: DispatchDependencies;
}): Promise<{ root: unknown; primary: Step<SlotTarget> }> {
  const health = await step(
    async () => Schema.decodeUnknownSync(RootHealth)(await input.deps.rootHealth(input.target)),
    "root health read failed",
  );
  const root = input.root;
  return {
    root: health.ok
      ? {
          instanceId: fingerprint(health.value.instanceId),
          imageHash: health.value.imageHash,
          stateImageInput: root?.imageInput ?? null,
          running: health.value.running,
          ready: health.value.ready,
          bootId: health.value.bootId ?? null,
        }
      : health,
    primary: !root
      ? { ok: false, error: "root application unavailable in release state; witness not sent" }
      : !/^sha256:[a-f0-9]{64}$/u.test(root.imageDigest)
        ? { ok: false, error: "root image digest unavailable in release state; witness not sent" }
        : !health.ok
          ? { ok: false, error: "root health unavailable; witness not sent" }
          : {
              ok: true,
              value: {
                format: "pool-runtime-slot-v1",
                controllerId: health.value.instanceId,
                instanceId: health.value.instanceId,
                slotId: "legacy",
                ...root,
              },
            },
  };
}

/**
 * Reads only: two membership inspects about 6 s apart (is renewal moving?), fleet enablement, the
 * health refusal, and the primary's retained admission witness. Once a selection exists the
 * controller owns recovery and refuses the root status read, so the witness names the selected
 * primary directly; the root boot is read only while no selection exists.
 */
async function diagnose(input: {
  inspected: unknown;
  observedAt: number;
  fleet: unknown;
  healthRefusal: string | undefined;
  root: RootApplication | undefined;
  controllerCode: ControllerCode;
  target: ReleaseTarget;
  deps: DispatchDependencies;
  send: (action: ObserveAction, slot?: SlotTarget) => Promise<unknown>;
}) {
  const fleet = fields(input.fleet);
  const permission = fields(fleet.permission);
  const selected = selectedTarget(input.inspected);
  const { root, primary } = selected
    ? { root: { skipped: "selection-present" }, primary: selected }
    : await legacyPrimary(input);
  const witness: Step<unknown> = !primary.ok
    ? primary
    : await step(async () => {
        const value = fields(await input.send("witness", primary.value));
        // An attested slot answers with its startup witness nested; an unattested adoption
        // answers flat (controller) or under its authorization (endpoint shape).
        const retained = value.kind === "witness" ? fields(value.witness) : value;
        const authorization = fields(value.authorization);
        return {
          slotId: primary.value.slotId,
          kind: text(value.kind),
          operationId: text(retained.operationId) ?? text(authorization.operationId),
          manifestDigest: text(retained.manifestDigest) ?? text(authorization.manifestDigest),
          bootId: text(retained.bootId) ?? text(fields(value.identity).bootId),
        };
      }, "witness outcome unknown");
  await input.deps.sleep(6_000);
  const second = await step(
    async () => membershipState(await input.send("inspect"), input.deps.now()),
    "second inspect outcome unknown",
  );
  return {
    inspect: [
      membershipState(input.inspected, input.observedAt),
      second.ok ? second.value : second,
    ],
    fleet: {
      enabled: typeof permission.enabled === "boolean" ? permission.enabled : null,
      resources: Array.isArray(fleet.resources) ? fleet.resources.length : null,
      bindings: Array.isArray(fleet.bindings) ? fleet.bindings.length : null,
    },
    activeHealth: { refused: input.healthRefusal ?? null },
    root,
    witness: witness.ok ? witness.value : witness,
  };
}

export async function runCrashDispatch(input: DispatchInput, deps: DispatchDependencies) {
  const startedAt = deps.now();
  let packetDigest: string | null = null;
  let forcedInspect = false;
  let phase = "input validation failed";
  const output: {
    observe?: unknown;
    diagnostic?: unknown;
    inspection?: unknown;
    result?: unknown;
  } = {};
  let error: string | null = null;
  try {
    if (!["observe", "inspect", "apply"].includes(input.mode))
      throw new DispatchRefusal("mode must be observe, inspect or apply");
    if (!uuid.test(input.requestId)) throw new DispatchRefusal("request_id must be a UUID");
    assertGo(input.coordinatorGo);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.packet);
    } catch {
      throw new DispatchRefusal("packet is not valid JSON");
    }
    // The consumer binds the result to the exact input it sent, so hash the raw string unparsed.
    packetDigest = createHash("sha256").update(input.packet).digest("hex");
    const preflight = async () => {
      if (input.ref !== "refs/heads/main")
        throw new DispatchRefusal("workflow must be dispatched on refs/heads/main");
      if (input.event !== "workflow_dispatch")
        throw new DispatchRefusal("workflow event must be workflow_dispatch");
      if (!/^[a-f0-9]{32}$/u.test(input.accountId))
        throw new DispatchRefusal("CLOUDFLARE_ACCOUNT_ID is unavailable");
      if (!isSigningKey(input.signingKey))
        throw new DispatchRefusal("POOL_DEPLOYMENT_KEY is unavailable");
    };
    const readTarget = async () => {
      phase = "release state read failed";
      const target = await deps.readTarget();
      if (target.accountId !== input.accountId)
        throw new DispatchRefusal("release state accountId must equal CLOUDFLARE_ACCOUNT_ID");
      return target;
    };
    if (input.mode === "observe") {
      const packet = decodePacket(ObservePacket, parsed, "{controllerCode}");
      await preflight();
      const { root, ...target } = await readTarget();
      const send = (action: ObserveAction, slot?: SlotTarget) => {
        phase = `${action} outcome unknown`;
        return deps
          .observe(action, packet.controllerCode, target, input.signingKey, slot)
          .then((reply) => replyResult(reply, action));
      };
      const inspected = await send("inspect");
      if (inspected === null || typeof inspected !== "object")
        throw new DispatchRefusal("inspect reply has no result");
      const observedAt = deps.now();
      const fleet = await send("fleet-inspect");
      // A controller refusal of the health read is evidence in itself; the selection and fleet
      // still stand. Any other failure (lost reply, timeout, malformed reply) fails the observe.
      let healthRefusal: string | undefined;
      const activeHealth = await send("active-health").catch((cause: unknown) => {
        if (!(cause instanceof ControllerRefused)) throw cause;
        healthRefusal = cause.reason;
        return null;
      });
      // An absent selection is the state to diagnose, so it is recorded instead of ending the read.
      const selection = "selection" in inspected ? inspected.selection : null;
      output.observe = redactAccount({ selection, fleet, activeHealth }, input.accountId);
      phase = "diagnostic read failed";
      output.diagnostic = redactAccount(
        await diagnose({
          inspected,
          observedAt,
          fleet,
          healthRefusal,
          root,
          controllerCode: packet.controllerCode,
          target,
          deps,
          send,
        }),
        input.accountId,
      );
    } else {
      const packet = decodePacket(
        CrashPacket,
        parsed,
        "{controllerCode, identity, nonce, operator}",
      );
      if (input.requestId !== packet.nonce)
        throw new DispatchRefusal("request_id must equal packet.nonce");
      await preflight();
      if (input.mode === "apply") forcedInspect = await replayed(input, deps);
      const target = await readTarget();
      const apply = input.mode === "apply" && !forcedInspect;
      phase = apply
        ? "runtime-crash outcome unknown; never retry apply, dispatch inspect with the same nonce"
        : "runtime-crash-inspect outcome unknown";
      const sent = await deps
        .crash({
          packet: { ...packet, accountId: target.accountId, worker: target.worker },
          mode: apply ? "apply" : "inspect",
          signingKey: input.signingKey,
        })
        .catch((cause: unknown) => {
          // Once sent, every failure keeps the uncertainty in front of its cause.
          throw new DispatchRefusal(
            cause instanceof DispatchRefusal
              ? `${phase}: ${cause.message}`
              : publicError(cause, phase),
          );
        });
      if (sent.inspection) output.inspection = redactAccount(sent.result, input.accountId);
      else output.result = redactAccount(sent.result, input.accountId);
    }
  } catch (cause) {
    error = publicError(cause, phase);
  }
  return {
    // A forced inspect reports what actually ran, so a consumer never reads it as an apply.
    mode: forcedInspect ? "inspect" : input.mode,
    requestId: input.requestId,
    packetDigest,
    coordinatorGo: input.coordinatorGo,
    startedAt,
    finishedAt: deps.now(),
    forcedInspect,
    ok: error === null,
    error,
    ...output,
  };
}

// The controller refuses a command signed in its future; a runner clock a little ahead must not do that.
const signedNow = () => Date.now() - 2_000;

/** The operator's receipt stays in a private runner directory; only its controller reply leaves it. */
export const crashSender =
  (directory: string, connect?: Connect): DispatchDependencies["crash"] =>
  async ({ packet, mode, signingKey }) => {
    if (!directory) throw new DispatchRefusal("runner temporary directory is unavailable");
    const scratch = await mkdtemp(join(directory, "pool-crash-"));
    try {
      const path = join(scratch, "packet.json");
      await writeFile(path, JSON.stringify(packet), { mode: 0o600, flag: "wx" });
      const { receiptPath } = await runCrashOperator(
        { packet: path, apply: mode === "apply" },
        signingKey,
        {
          connect,
          now: signedNow,
        },
      );
      const receipt = Schema.decodeUnknownSync(
        Schema.Struct({
          digest: Schema.String,
          inspection: Schema.Boolean,
          result: Schema.Unknown,
        }),
      )(JSON.parse(await readFile(receiptPath, "utf8")));
      const action = receipt.inspection ? "runtime-crash-inspect" : "runtime-crash";
      return { inspection: receipt.inspection, result: replyResult(receipt.result, action) };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  };

/** The controller answered with its own handoff refusal (409 runtime-handoff-refused). */
export class ControllerRefused extends Error {
  /** The controller's fixed runtime failure code, safe to publish. */
  readonly reason: string;
  constructor(action: string, reason: string) {
    super(`${action} refused by the controller`);
    this.reason = reason;
  }
}

export const observeSender =
  (connect?: Connect): DispatchDependencies["observe"] =>
  async (action, controllerCode, target, signingKey, slot) => {
    const at = signedNow();
    const command = decodeRuntimeHandoffCommand(
      { controllerCode, action, at, expiresAt: at + 25_000, ...(slot ? { target: slot } : {}) },
      at,
    );
    // The shared RPC folds every non-200 into one refusal, so record whether the controller itself
    // refused; a defect, auth rejection or bridge failure must not read as a refusal.
    let refused: string | undefined;
    const observed: NonNullable<Connect> = async (path) => {
      const platform = await (connect
        ? connect(path)
        : nodePoolOperations(target.accountId, target.worker));
      const service = platform.env.POOL_OPERATIONS;
      return {
        ...platform,
        env: {
          POOL_OPERATIONS: {
            fetch: async (request: Request) => {
              const response = await service.fetch(request);
              if (response.status === 409) {
                const body: unknown = await response
                  .clone()
                  .json()
                  .catch(() => undefined);
                if (
                  body &&
                  typeof body === "object" &&
                  "error" in body &&
                  body.error === "runtime-handoff-refused"
                )
                  refused =
                    "reason" in body &&
                    typeof body.reason === "string" &&
                    /^[a-z0-9_-]{1,64}$/u.test(body.reason)
                      ? body.reason
                      : "unspecified";
              }
              return response;
            },
          },
        },
      };
    };
    try {
      return await sendRuntimeCommand(command, signingKey, { ...target, connect: observed }, () => {
        decodeRuntimeHandoffCommand(command, signedNow());
      });
    } catch (cause) {
      if (refused) throw new ControllerRefused(action, refused);
      throw cause;
    }
  };

/** Unsigned GET of the root container's recovery status; the POST path is the only one that restarts. */
export const rootHealthReader =
  (connect?: Connect): DispatchDependencies["rootHealth"] =>
  async (target) => {
    const connection = await openPoolOperations({ ...target, connect });
    try {
      const response = await connection.service.fetch(
        new Request(`http://pool-operations${runtimeRecoveryPath}`, {
          signal: AbortSignal.timeout(15_000),
        }),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new DispatchRefusal(`root health HTTP ${response.status}`);
      }
      return await response.json();
    } finally {
      await connection.close();
    }
  };

export async function writeDispatchResult(directory: string, result: object) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "result.json"), JSON.stringify(result), { mode: 0o600 });
}

// Free-form inputs never reach the log, so a dispatch cannot inject workflow commands.
export const logLine = (result: Awaited<ReturnType<typeof runCrashDispatch>>) =>
  `mode=${["observe", "inspect", "apply"].includes(result.mode) ? result.mode : "invalid"} ` +
  `request_id=${uuid.test(result.requestId) ? result.requestId : "invalid"} ` +
  `ok=${result.ok} forcedInspect=${result.forcedInspect}\n`;

if (import.meta.main) {
  const env = process.env;
  let ok = false;
  try {
    const temporary = env.POOL_CRASH_TEMPORARY_DIRECTORY ?? "";
    const result = await runCrashDispatch(
      {
        mode: env.POOL_CRASH_MODE ?? "",
        requestId: env.POOL_CRASH_REQUEST_ID ?? "",
        packet: env.POOL_CRASH_PACKET ?? "",
        coordinatorGo: env.POOL_CRASH_COORDINATOR_GO ?? "",
        accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "",
        signingKey: env.POOL_DEPLOYMENT_KEY ?? "",
        ref: env.GITHUB_REF ?? "",
        event: env.GITHUB_EVENT_NAME ?? "",
        runId: Number(env.GITHUB_RUN_ID),
        runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
      },
      {
        listRuns: workflowRunLister(env.GITHUB_REPOSITORY ?? "", env.GITHUB_TOKEN ?? ""),
        readTarget: () => readReleaseTarget(env),
        observe: observeSender(),
        crash: crashSender(temporary),
        rootHealth: rootHealthReader(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now,
      },
    );
    await writeDispatchResult(env.POOL_CRASH_OUTPUT_DIRECTORY ?? "", result);
    process.stdout.write(logLine(result));
    ok = result.ok;
  } catch {
    process.stderr.write("Crash dispatch result unavailable.\n");
  }
  if (!ok) process.exitCode = 1;
}
