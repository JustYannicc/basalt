import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { runtimeRecoveryPath } from "../src/pool/recovery-approval.ts";
import {
  BoundProviderObservation,
  ProviderObservationTarget,
} from "../src/pool/runtime-provider/observation.ts";
import {
  ControllerCode,
  SlotIdentity,
  SlotRefused,
  SlotTarget,
} from "../src/pool/runtime-slots/contract.ts";
import { decodeRuntimeHandoffCommand } from "../src/pool/runtime-slots/handoff-command.ts";
import { runtimeFailureCode } from "../src/pool/runtime-route-diagnostic.ts";
import { isSigningKey } from "../src/pool/token.ts";
import { runCrashOperator } from "./pool-crash-operator.ts";
import { openPoolOperations, type PoolOperationsTarget } from "./pool-operations.ts";
import { nodePoolOperations } from "./pool-operations-node.ts";
import { BarrierRefusal } from "./pool-fleet/refusal.ts";
import { sameProvisioningValue } from "./pool-fleet/provisioning-refusal.ts";
import { providerObservationCause, sendRuntimeCommand } from "./pool-fleet/runtime-command-rpc.ts";
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
const observeActions = [
  "inspect",
  "fleet-inspect",
  "active-health",
  "witness",
  "provider-observe",
] as const;
const modes = ["observe", "inspect", "apply", "recovery-reset"];
type ObserveAction = (typeof observeActions)[number];
/** A witness names a slot; a provider observation names the application pins it compares. */
type ObserveSubject = SlotTarget | ProviderObservationTarget;
type Connect = PoolOperationsTarget["connect"];

export interface DispatchDependencies {
  listRuns(): Promise<readonly { id: number; displayTitle: string }[]>;
  readTarget(): Promise<
    ReleaseTarget & { root?: RootApplication; provider?: ProviderObservationTarget }
  >;
  observe(
    action: ObserveAction,
    controllerCode: ControllerCode,
    target: ReleaseTarget,
    signingKey: string,
    subject?: ObserveSubject,
  ): Promise<unknown>;
  /**
   * The root PoolContainer's unsigned recovery status read: identity and boot, never a restart.
   * Only meaningful without a selection; the controller refuses it once one exists.
   */
  rootHealth(target: ReleaseTarget): Promise<unknown>;
  /** Clears the controller's forced-restart limit and its needs-a-person mark; nothing else. */
  resetRecovery(
    controllerCode: ControllerCode,
    target: ReleaseTarget,
    signingKey: string,
    operationId: string,
  ): Promise<unknown>;
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
// The Node bridge's own fixed failures (pool-operations-node.ts), so a transport fault never reads as
// a Worker that did not answer: its lifecycle, and a request its child could not complete, which
// carries only a closed error name.
const BRIDGE_FAILURE =
  /^Private operations Node bridge (exited|disconnected|send failed|failed|startup timed out|closed)$/u;
const BRIDGE_REQUEST_FAILED = "Private operations request failed";
const BRIDGE_ERROR_NAMES = new Set(["Error", "TypeError", "AbortError", "TimeoutError"]);
/** The bridge's own failure as closed text, or undefined for anything else. */
function bridgeFailure(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  const lifecycle = BRIDGE_FAILURE.exec(error.message)?.[1];
  if (lifecycle) return lifecycle;
  return error.message === BRIDGE_REQUEST_FAILED
    ? `request failed (${BRIDGE_ERROR_NAMES.has(error.name) ? error.name : "Error"})`
    : undefined;
}

/** The HTTP status of a reply the shared RPC refused, as a number and nothing else from it. */
function httpStatus(error: BarrierRefusal) {
  if (error.reason !== "runtime-handoff-response-refused") return "";
  const entry = error.delta?.changed.find((change) => change.path === "handoff.response.http");
  const status = entry && "new" in entry ? entry.new : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? ` HTTP ${status}`
    : "";
}

/**
 * A read lost between this process and the Worker, with no answer the Worker classified: the
 * bridge failed, nothing answered in time, or something answered other than the Worker's 200 or
 * its own 409 (the proxy, the edge, or a Worker defect). Each attempt opens its own bridge, so
 * only these are worth another one.
 */
const lostOnTheWay = (cause: unknown) =>
  !providerObservationCause(cause) &&
  ((cause instanceof BarrierRefusal &&
    cause.reason === "runtime-handoff-response-refused" &&
    // A 409 is the Worker's own refusal form, an answer.
    httpStatus(cause) !== " HTTP 409") ||
    (cause instanceof DOMException &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")) ||
    bridgeFailure(cause) !== undefined ||
    cause instanceof CommandExpiredLocally);
/** Attempts in all for one observe read; commands that write are never sent twice. */
export const observeAttempts = 3;
/** How many attempts an observe read took, keyed by the reply or the error it ended with. */
const attemptsTaken = new WeakMap<object, number>();
export const attemptsOf = (value: unknown) =>
  (value !== null && typeof value === "object" && attemptsTaken.get(value)) || 1;
const retriedLine = new RegExp(
  `^(?:${observeActions.join("|")}) (?:gave up after )?[2-${observeAttempts}] attempts$`,
  "u",
);

function publicError(error: unknown, phase: string) {
  if (error instanceof DispatchRefusal) return error.message;
  const bridge = bridgeFailure(error);
  const code =
    error instanceof ControllerRefused
      ? `: runtime-handoff-refused (${error.reason})`
      : error instanceof BarrierRefusal
        ? `: ${error.reason}${error.worker ? ` (${error.worker})` : ""}${httpStatus(error)}`
        : error instanceof SlotRefused
          ? `: ${error.reason}`
          : // No reply within the request's own time limit.
            error instanceof DOMException &&
              (error.name === "AbortError" || error.name === "TimeoutError")
            ? `: ${error.name}`
            : bridge
              ? `: bridge ${bridge}`
              : error instanceof CommandExpiredLocally
                ? ": expired before it was sent"
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

const providerCauses = [
  "provider_observation_refused",
  "provider_fetch_failed",
  "controller_identity",
  "controller_refused",
  "reply_unreadable",
  "no_reply",
  "bridge_failed",
  "expired_unsent",
  "response_refused",
  "outcome_unknown",
  "target_unavailable",
] as const;
type ProviderCause = (typeof providerCauses)[number];
const providerLine = (cause?: ProviderCause) =>
  cause
    ? (`provider observation: does not read (${cause})` as const)
    : ("provider observation: reads" as const);
type ProviderLine = ReturnType<typeof providerLine>;
const providerLines = new Set<string>([providerLine(), ...providerCauses.map(providerLine)]);
// The handoff's refusal for a command naming other controller code, or one it cannot decode.
const identityRefusal = runtimeFailureCode({
  runtimeStep: "endpoint_route",
  runtimeReason: "slot_identity",
});

const uncheckedRestart = [
  "selection_unavailable",
  "no_selected_runtime",
  "selection_unreadable",
  "selected_runtime_not_root",
  "target_unavailable",
] as const;
type RestartLine =
  | "restart read: passes"
  | "restart read: refuses (recorded_pins_differ)"
  | `restart read: does not read (${ProviderCause})`
  | `restart read: not checked (${(typeof uncheckedRestart)[number]})`;
const restartLines = new Set<string>([
  "restart read: passes",
  "restart read: refuses (recorded_pins_differ)",
  ...providerCauses.map((cause) => `restart read: does not read (${cause})`),
  ...uncheckedRestart.map((cause) => `restart read: not checked (${cause})`),
]);

/**
 * The Worker reads the root application with its own POOL_PROVIDER_OBSERVATION_TOKEN binding, as a
 * heal's restart does at admission and attestation, and compares it to these pins. The reply names
 * the account, application and digests, so only a closed cause ever leaves this function.
 */
async function providerRead(
  target: ProviderObservationTarget,
  send: (target: ProviderObservationTarget) => Promise<unknown>,
): Promise<ProviderCause | undefined> {
  let reply: unknown;
  try {
    reply = await send(target);
  } catch (cause) {
    // The Worker's failure header outranks the body's reason, which a non-provider 409 also has.
    return (
      providerObservationCause(cause) ??
      (cause instanceof ControllerRefused
        ? cause.reason === identityRefusal
          ? "controller_identity"
          : "controller_refused"
        : cause instanceof DispatchRefusal
          ? "reply_unreadable"
          : // Something answered other than the Worker's 200 or the handoff's own 409: the proxy,
            // the edge, or a Worker defect. The error's HTTP status tells which.
            cause instanceof BarrierRefusal
            ? "response_refused"
            : cause instanceof DOMException &&
                (cause.name === "AbortError" || cause.name === "TimeoutError")
              ? "no_reply"
              : bridgeFailure(cause) !== undefined
                ? "bridge_failed"
                : cause instanceof CommandExpiredLocally
                  ? "expired_unsent"
                  : "outcome_unknown")
    );
  }
  try {
    const { proof } = Schema.decodeUnknownSync(BoundProviderObservation)(reply);
    // The proof must name exactly the pins sent; its observation digest and time stay unread.
    sameProvisioningValue(
      "provider.observation.target",
      target,
      Schema.decodeUnknownSync(ProviderObservationTarget)(proof),
    );
    return undefined;
  } catch {
    return "reply_unreadable";
  }
}

/** The token read: the live application's own pins, so a refusal speaks for the binding. */
async function providerObservation(
  target: ProviderObservationTarget | undefined,
  send: (target: ProviderObservationTarget) => Promise<unknown>,
): Promise<ProviderLine> {
  return providerLine(target ? await providerRead(target, send) : "target_unavailable");
}

/**
 * The restart's first read, after the stop, compares the live application with the pins recorded
 * when the selected runtime was admitted. Admission makes the selection's target carry three of
 * them exactly (application, version, image digest). No deployed reply carries the recorded
 * namespace or configuration digest, so those two are the live ones: their drift shows only if it
 * also moved the version. The Worker refuses a dead token and differing pins alike, so the local
 * comparison names which one it was.
 */
async function restartObservation(
  live: ProviderObservationTarget | undefined,
  inspected: unknown,
  send: (target: ProviderObservationTarget) => Promise<unknown>,
): Promise<RestartLine> {
  if (!live) return "restart read: not checked (target_unavailable)";
  const selected = selectedTarget(inspected);
  if (!selected) return "restart read: not checked (no_selected_runtime)";
  if (!selected.ok) return "restart read: not checked (selection_unreadable)";
  const { applicationId, applicationVersion, imageDigest } = selected.value;
  // The heal restarts the root; a selection on another application is not what this reads.
  if (applicationId !== live.applicationId)
    return "restart read: not checked (selected_runtime_not_root)";
  const cause = await providerRead({ ...live, applicationVersion, imageDigest }, send);
  if (cause === undefined) return "restart read: passes";
  const differs =
    applicationVersion !== live.applicationVersion || imageDigest !== live.imageDigest;
  return differs && cause === "provider_observation_refused"
    ? "restart read: refuses (recorded_pins_differ)"
    : `restart read: does not read (${cause})`;
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
  send: (action: ObserveAction, subject?: ObserveSubject) => Promise<unknown>;
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
    providerObservation?: ProviderLine;
    restartObservation?: RestartLine;
    retried?: string[];
    observe?: unknown;
    diagnostic?: unknown;
    inspection?: unknown;
    result?: unknown;
  } = {};
  let error: string | null = null;
  try {
    if (!modes.includes(input.mode))
      throw new DispatchRefusal("mode must be observe, inspect, apply or recovery-reset");
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
      const { root, provider, ...target } = await readTarget();
      // The observe sender sends a read lost on the way again; this records how many attempts.
      const send = async (action: ObserveAction, subject?: ObserveSubject) => {
        phase = `${action} outcome unknown`;
        try {
          const reply = await deps.observe(
            action,
            packet.controllerCode,
            target,
            input.signingKey,
            subject,
          );
          const attempts = attemptsOf(reply);
          if (attempts > 1) (output.retried ??= []).push(`${action} ${attempts} attempts`);
          return replyResult(reply, action);
        } catch (cause) {
          const attempts = attemptsOf(cause);
          if (attempts > 1) {
            phase = `${action} outcome unknown after ${attempts} attempts`;
            // A caller may catch this read's error (the provider lines do), so the record keeps it.
            (output.retried ??= []).push(`${action} gave up after ${attempts} attempts`);
          }
          throw cause;
        }
      };
      // First and never fatal: a heal needs this read whatever state the selection is in.
      output.providerObservation = await providerObservation(provider, (pins) =>
        send("provider-observe", pins),
      );
      // The selection the restart read needs; without it line 2 says so, and the error says why.
      const inspected = await send("inspect").catch((cause: unknown) => {
        output.restartObservation = "restart read: not checked (selection_unavailable)";
        throw cause;
      });
      // Never fatal either: whatever the selection reads, the line says why it was not checked.
      output.restartObservation = await restartObservation(provider, inspected, (pins) =>
        send("provider-observe", pins),
      );
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
    } else if (input.mode === "recovery-reset") {
      const packet = decodePacket(ObservePacket, parsed, "{controllerCode}");
      await preflight();
      const { root: _root, provider: _provider, ...target } = await readTarget();
      // What is about to be cleared is recorded first, so the result shows the state it replaced.
      phase = "inspect outcome unknown";
      const inspected = replyResult(
        await deps.observe("inspect", packet.controllerCode, target, input.signingKey),
        "inspect",
      );
      const before =
        inspected && typeof inspected === "object" && "recovery" in inspected
          ? inspected.recovery
          : null;
      phase = "recovery-reset outcome unknown; inspect shows whether it applied";
      output.observe = redactAccount({ recovery: before }, input.accountId);
      output.result = redactAccount(
        replyResult(
          await deps.resetRecovery(
            packet.controllerCode,
            target,
            input.signingKey,
            `recovery-reset-${input.requestId}`,
          ),
          "recovery-reset",
        ),
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

/** A command that expired here before it was sent: it never reached the Worker. */
export class CommandExpiredLocally extends Error {
  constructor() {
    super("Runtime handoff command expired before it was sent");
  }
}

/** The controller answered with its own handoff refusal (409 runtime-handoff-refused). */
export class ControllerRefused extends Error {
  /** The controller's fixed runtime failure code, safe to publish. */
  readonly reason: string;
  constructor(action: string, reason: string) {
    super(`${action} refused by the controller`);
    this.reason = reason;
  }
}

// Every observe command is a read. The Worker caps its own provider read at 15 s, so the client
// waits past that for the Worker's named answer instead of giving up first.
export const observeLimitMs = 30_000;

/**
 * Every command here is a read, so one lost on the way (`lostOnTheWay`) is sent again, signed anew
 * and on its own fresh bridge, up to `observeAttempts` in all. An answer the Worker classified is
 * never sent again. Commands that write go through their own senders and are sent once.
 */
export const observeSender =
  (connect?: Connect): DispatchDependencies["observe"] =>
  async (action, controllerCode, target, signingKey, subject) => {
    // The closed list of reads, whatever a caller passes: anything else is sent once.
    const attempts = (observeActions as readonly string[]).includes(action) ? observeAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        // Signed anew each attempt: a command expires 25 s after it is signed.
        const reply = await signedCommand(
          connect,
          action,
          controllerCode,
          target,
          signingKey,
          subject ? { target: subject } : {},
          observeLimitMs,
        );
        if (attempt > 1 && reply !== null && typeof reply === "object")
          attemptsTaken.set(reply, attempt);
        return reply;
      } catch (cause) {
        if (attempt < attempts && lostOnTheWay(cause)) continue;
        if (attempt > 1 && cause !== null && typeof cause === "object")
          attemptsTaken.set(cause, attempt);
        throw cause;
      }
    }
  };

// A reset writes, so it keeps the shared RPC's own limit.
export const recoveryResetSender =
  (connect?: Connect): DispatchDependencies["resetRecovery"] =>
  (controllerCode, target, signingKey, operationId) =>
    signedCommand(connect, "recovery-reset", controllerCode, target, signingKey, { operationId });

async function signedCommand(
  connect: Connect | undefined,
  action: string,
  controllerCode: ControllerCode,
  target: ReleaseTarget,
  signingKey: string,
  fields: { target?: ObserveSubject; operationId?: string },
  limitMs?: number,
) {
  // The closed command union decides which subject an action may carry; any other pairing refuses.
  const build = () => {
    const at = signedNow();
    return decodeRuntimeHandoffCommand(
      { controllerCode, action, at, expiresAt: at + 25_000, ...fields },
      at,
    );
  };
  // Once before any bridge opens, so a command the union refuses never opens one.
  build();
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
    return await sendRuntimeCommand(
      // Signed once the bridge is open: a bridge may take up to 30 s to start, and a command lives
      // 25 s from its signature.
      async () => build(),
      signingKey,
      { ...target, connect: observed },
      (frozen) => {
        // The shape was decoded when it was built, so only its time can fail here.
        try {
          decodeRuntimeHandoffCommand(frozen, signedNow());
        } catch {
          throw new CommandExpiredLocally();
        }
      },
      undefined,
      undefined,
      undefined,
      limitMs,
    );
  } catch (cause) {
    // The provider-observation header is the Worker's own closed cause; keep it.
    if (providerObservationCause(cause)) throw cause;
    if (refused) throw new ControllerRefused(action, refused);
    throw cause;
  }
}

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
  `mode=${modes.includes(result.mode) ? result.mode : "invalid"} ` +
  `request_id=${uuid.test(result.requestId) ? result.requestId : "invalid"} ` +
  `ok=${result.ok} forcedInspect=${result.forcedInspect}\n` +
  (result.providerObservation && providerLines.has(result.providerObservation)
    ? `${result.providerObservation}\n`
    : "") +
  (result.restartObservation && restartLines.has(result.restartObservation)
    ? `${result.restartObservation}\n`
    : "") +
  (result.retried?.length && result.retried.every((line) => retriedLine.test(line))
    ? `retried: ${result.retried.join("; ")}\n`
    : "");

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
        resetRecovery: recoveryResetSender(),
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
