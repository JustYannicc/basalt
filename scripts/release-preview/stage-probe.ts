/**
 * Interruption probe for a rehearsal stage's PoolWorker update. It runs beside the Alchemy apply in
 * the same Actions job and answers two questions: how long the controller Durable Object stops
 * answering a signed `inspect`, and whether the legacy root container keeps its boot through it.
 *
 *   node scripts/release-preview/stage-probe.ts <lane> <outFile>
 *
 * Samples until SIGTERM or SIGINT, streams them to <outFile> as JSONL, and prints the summary as one
 * JSON line. It only reads: a signed `inspect`, then the root's unsigned status GET (or the signed
 * `active-health` once a selection exists). Neither starts, restarts or repairs anything.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { poolWorkerRevisionModule } from "../pool-worker-revision.ts";

export type SendResult =
  | { ok: true; rootIdentity?: string; controllerCode?: string; note?: string }
  | { ok: false; reason: string };
export type Sample = {
  at: number;
  ms: number;
  ok: boolean;
  reason?: string;
  rootIdentity?: string;
  controllerCode?: string;
};

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** One sample per tick until `signal` aborts. A send cut short by the stop is not recorded. */
export async function probeLoop(options: {
  send: (signal: AbortSignal) => Promise<SendResult>;
  intervalMs?: number;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  onSample?: (sample: Sample) => void | Promise<void>;
}): Promise<Sample[]> {
  const { send, intervalMs = 2000, signal, now = Date.now, sleep = abortableSleep } = options;
  const samples: Sample[] = [];
  let next = now();
  while (!signal.aborted) {
    const at = now();
    let result: SendResult;
    try {
      result = await send(signal);
    } catch (error) {
      // The real send never throws; a defect still costs one failed sample, not the probe.
      result = {
        ok: false,
        reason: `send-threw-${error instanceof Error ? error.name : "unknown"}`,
      };
    }
    if (signal.aborted) break;
    const sample: Sample = { at, ms: now() - at, ok: result.ok };
    const reason = result.ok ? result.note : result.reason;
    if (reason !== undefined) sample.reason = reason;
    if (result.ok && result.rootIdentity !== undefined) sample.rootIdentity = result.rootIdentity;
    if (result.ok && result.controllerCode !== undefined)
      sample.controllerCode = result.controllerCode;
    samples.push(sample);
    try {
      await options.onSample?.(sample);
    } catch {
      // Streaming is best effort; the caller rewrites the whole file from the returned samples.
    }
    // Fixed-rate ticks: a slow send shortens the next gap instead of drifting the schedule.
    next = Math.max(next + intervalMs, now());
    await sleep(next - now(), signal);
  }
  return samples;
}

/**
 * An outage runs from its first failed sample to the next successful one, so it is resolved to
 * one tick. A run still failing at the end is closed at its last failure's reply.
 */
export function summarize(samples: readonly Sample[]) {
  let failures = 0;
  let longestOutageMs = 0;
  let firstFailureAt: number | null = null;
  let lastFailureAt: number | null = null;
  let outageStart: number | undefined;
  let lastFailure: Sample | undefined;
  const rootIdentities: string[] = [];
  for (const sample of samples) {
    if (sample.rootIdentity !== undefined && !rootIdentities.includes(sample.rootIdentity))
      rootIdentities.push(sample.rootIdentity);
    if (!sample.ok) {
      failures += 1;
      firstFailureAt ??= sample.at;
      lastFailureAt = sample.at;
      outageStart ??= sample.at;
      lastFailure = sample;
      continue;
    }
    if (outageStart !== undefined) {
      longestOutageMs = Math.max(longestOutageMs, sample.at - outageStart);
      outageStart = undefined;
    }
  }
  if (outageStart !== undefined && lastFailure)
    longestOutageMs = Math.max(longestOutageMs, lastFailure.at + lastFailure.ms - outageStart);
  return {
    samples: samples.length,
    failures,
    longestOutageMs,
    firstFailureAt,
    lastFailureAt,
    rootIdentities,
    rootChanged: rootIdentities.length > 1,
  };
}

const sameCode = (left: ControllerCode, right: ControllerCode) =>
  left.candidate === right.candidate && left.workerInput === right.workerInput;

/**
 * The controller refuses any command whose code is not its own, so the probe must follow the PUT.
 * Sources are ordered cheapest first; after a refusal each is re-read at most once, and the first
 * one naming a different code wins. Before the PUT the stage's recorded code answers, after it
 * the checkout's does.
 */
export function codeFollower(sources: readonly (() => Promise<ControllerCode>)[]) {
  let current: ControllerCode | undefined;
  return {
    current: () => current,
    async refused(code?: ControllerCode) {
      for (const read of sources) {
        const next = await read().catch(() => undefined);
        if (next && (!code || !sameCode(next, code))) {
          current = next;
          return true;
        }
      }
      return false;
    },
  };
}

/** A code mismatch reads as an identity refusal on the controller's own route. */
export function refusalReason(
  action: "inspect" | "active-health",
  status: number,
  diagnostic?: { runtimeStep: string; runtimeReason: string },
) {
  if (action === "inspect" && status === 409 && diagnostic?.runtimeReason === "slot_identity")
    return { reason: "controller-code-mismatch", codeMismatch: true };
  const detail = diagnostic ? `-${diagnostic.runtimeStep}-${diagnostic.runtimeReason}` : "";
  return { reason: `${action}-http-${status}${detail}`, codeMismatch: false };
}

const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
// The instance id is the controller's own Durable Object id; only a fingerprint leaves the run.
const fingerprint = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The root's unsigned status read: its live boot, or why there is none. */
export function rootFromRecovery(body: unknown): { rootIdentity?: string; note?: string } {
  const value = fields(body);
  const instanceId = text(value.instanceId);
  const bootId = text(value.bootId);
  if (!instanceId) return { note: "root-status-unreadable" };
  if (value.running !== true) return { note: "root-not-running" };
  if (!bootId) return { note: "root-not-ready" };
  return { rootIdentity: `${fingerprint(instanceId)}:${bootId}` };
}

/** With a selection, a passing health read proves the recorded boot is still the live one. */
export function rootFromActiveHealth(result: unknown): { rootIdentity?: string; note?: string } {
  const identity = fields(fields(result).identity);
  const instanceId = text(identity.instanceId);
  const bootId = text(identity.bootId);
  if (!instanceId || !bootId) return { note: "active-health-unreadable" };
  if (identity.slotId !== "legacy") return { note: "selected-slot-not-root" };
  return { rootIdentity: `${fingerprint(instanceId)}:${bootId}` };
}

const opsReleaseModule = ".upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";

/** The code this checkout's build carries: what the apply PUTs. */
export async function checkoutCode(root: string): Promise<ControllerCode> {
  const [release, revision] = await Promise.all([
    readFile(join(root, opsReleaseModule), "utf8"),
    readFile(join(root, poolWorkerRevisionModule), "utf8"),
  ]);
  const candidate = /productionOpsRelease = "([a-f0-9]{40})"/u.exec(release)?.[1];
  const workerInput = /poolWorkerRevision = "([a-f0-9]{64})"/u.exec(revision)?.[1];
  if (!candidate || !workerInput) throw new Error("The checkout has no generated controller code");
  return { candidate, workerInput };
}

/** The code the stage last finished deploying, from its readiness row, read-only as the crash dispatch reads. */
async function stateCode(env: NodeJS.ProcessEnv): Promise<ControllerCode> {
  const [{ Cause, ConfigProvider, Context, Effect, Exit, Logger }, { FetchHttpClient }] =
    await Promise.all([import("effect"), import("effect/http")]);
  const [{ State }, { evalStack }] = await Promise.all([
    import("alchemy/State/State"),
    import("alchemy/Stack"),
  ]);
  const rehearsal = await import("../release-barrier/release-resume-rehearsal.ts");
  const { releaseStateStack } = await import("../release-barrier/release-state-stack.ts");
  const { assertReleaseStateVersion } = await import("../release-barrier/release-state-version.ts");
  const { withReleaseRuntime } = await import("../release-barrier/runtime.ts");
  const { readBaselineController } = await import("../release-barrier/baseline-controller.ts");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const counters = rehearsal.createRehearsalCounters();
  const nativeFetch = globalThis.fetch;
  const guarded = rehearsal.countReadOnlyProbeFetch(accountId, counters, nativeFetch);
  // The loop is sequential, so no bridge request runs while the GET-only guard is installed.
  globalThis.fetch = guarded;
  try {
    const program = evalStack(
      releaseStateStack,
      (compiled) =>
        Effect.gen(function* () {
          yield* assertReleaseStateVersion(compiled, guarded, "forward-probe");
          const state = rehearsal.countReadOnlyState(yield* yield* State, counters);
          const services = Context.add(compiled.services, State, Effect.succeed(state));
          const controller = yield* readBaselineController(compiled).pipe(
            Effect.provideContext(services),
          );
          return controller.code;
        }).pipe(Effect.provideContext(compiled.services)),
      { stage: env.ALCHEMY_STAGE ?? "" },
    );
    const exit = await Effect.runPromiseExit(
      program.pipe(
        withReleaseRuntime,
        Effect.timeout("2 minutes"),
        Effect.provide(Logger.layer([])),
        Effect.provideService(FetchHttpClient.Fetch, guarded),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                ALCHEMY_STAGE: env.ALCHEMY_STAGE ?? "",
                CI: "true",
                CLOUDFLARE_ACCOUNT_ID: accountId,
                CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? "",
                EXECUTOR_ENCRYPTION_KEY: env.EXECUTOR_ENCRYPTION_KEY ?? "",
              },
            }),
          ),
        ),
      ),
    );
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    if (counters.state.writeAttempts || counters.fetch.blockedMutationAttempts)
      throw new Error("The stage state read attempted a mutation");
    return exit.value;
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

/** The stage's one PoolWorker script, found by the tags Alchemy puts on it. */
async function stagePoolWorker(accountId: string, token: string, stage: string) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
  );
  const body = (await response.json()) as {
    success?: boolean;
    result?: { id: string; tags?: string[] }[];
  };
  if (!response.ok || body.success === false)
    throw new Error(`Cloudflare script list failed with HTTP ${response.status}`);
  const found = (body.result ?? []).filter(
    (script) =>
      script.tags?.includes(`alchemy:stage:${stage}`) &&
      script.tags.includes("alchemy:id:PoolWorker"),
  );
  if (found.length !== 1) throw new Error(`The stage has ${found.length} PoolWorker scripts`);
  return found[0]!.id;
}

async function main(args: string[], env: NodeJS.ProcessEnv) {
  // Registered before any await: a stop that arrives while the bridge opens still ends in a summary.
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const { redactor, describeError } = await import("./redact.ts");
  const [laneText, outFile] = args;
  if (!laneText || !outFile) throw new Error("Usage: stage-probe.ts <lane> <outFile>");
  if (env.GITHUB_ACTIONS !== "true") throw new Error("The stage probe runs only in GitHub Actions");
  const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  const stateKey = env.PREVIEW_STATE_KEY ?? "";
  if (!/^[a-f0-9]{32}$/u.test(accountId) || !token || !stateKey)
    throw new Error(
      "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and PREVIEW_STATE_KEY are required",
    );
  const [{ laneSubject }, { stageNames }, { stageKey, deriveStageSecrets }] = await Promise.all([
    import("./stage.ts"),
    import("../preview/subject.ts"),
    import("./keys.ts"),
  ]);
  const subject = laneSubject(Number(laneText));
  const { stage } = stageNames(subject);
  const key = stageKey(stateKey, subject, "POOL_DEPLOYMENT_KEY");
  const derived = {
    POOL_DEPLOYMENT_KEY: key,
    EXECUTOR_ENCRYPTION_KEY: deriveStageSecrets(stateKey, subject).EXECUTOR_ENCRYPTION_KEY,
  };
  const redact = redactor(env, derived);
  // The release state stack picks its Alchemy stack name from this at import.
  process.env.ALCHEMY_STAGE = stage;
  const stateEnv = { ...env, ...derived, ALCHEMY_STAGE: stage };

  const [
    { openPoolOperations },
    { signEnvelope },
    { decodeRuntimeHandoffCommand, runtimeHandoffCommandPrefix, runtimeHandoffPath },
    { runtimeRecoveryPath },
    { runtimeResponseDiagnostic },
  ] = await Promise.all([
    import("../pool-operations.ts"),
    import("../../src/pool/token.ts"),
    import("../../src/pool/runtime-slots/handoff-command.ts"),
    import("../../src/pool/recovery-approval.ts"),
    import("../../src/pool/runtime-route-diagnostic.ts"),
  ]);
  const root = fileURLToPath(new URL("../../", import.meta.url));
  let stateFailure: string | undefined;
  const follower = codeFollower([
    () => checkoutCode(root),
    () =>
      stateCode(stateEnv).catch((error: unknown) => {
        stateFailure = describeError(error, redact);
        throw error;
      }),
  ]);
  await follower.refused();

  const worker = await stagePoolWorker(accountId, token, stage);
  // One bridge for the whole run, so every sample times the controller and not bridge setup.
  const bridge = await openPoolOperations({ accountId, worker });
  const bounded = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const signed = async (
    action: "inspect" | "active-health",
    code: ControllerCode,
    signal: AbortSignal,
  ) => {
    // A runner clock a little ahead must not sign a command in the controller's future.
    const at = Date.now() - 2_000;
    const command = decodeRuntimeHandoffCommand(
      { controllerCode: code, action, at, expiresAt: at + 25_000 },
      Date.now(),
    );
    const envelope = await signEnvelope(key, runtimeHandoffCommandPrefix, command);
    return bridge.service.fetch(
      new Request(`http://pool-operations${runtimeHandoffPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope }),
        signal: bounded(signal),
      }),
    );
  };
  const failure = (error: unknown) =>
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
      ? error.name === "TimeoutError"
        ? "timeout"
        : "aborted"
      : `transport: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
  const rootRead = async (selected: boolean, code: ControllerCode, signal: AbortSignal) => {
    try {
      if (selected) {
        const response = await signed("active-health", code, signal);
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          return {
            note: refusalReason(
              "active-health",
              response.status,
              runtimeResponseDiagnostic(response),
            ).reason,
          };
        }
        return rootFromActiveHealth(fields(await response.json()).result);
      }
      const response = await bridge.service.fetch(
        new Request(`http://pool-operations${runtimeRecoveryPath}`, { signal: bounded(signal) }),
      );
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return { note: `root-status-http-${response.status}` };
      }
      return rootFromRecovery(await response.json());
    } catch (error) {
      return { note: `root-${failure(error)}` };
    }
  };
  const send = async (signal: AbortSignal): Promise<SendResult> => {
    const code = follower.current();
    if (!code) {
      await follower.refused();
      return { ok: false, reason: "controller-code-unavailable" };
    }
    let response: Response;
    try {
      response = await signed("inspect", code, signal);
    } catch (error) {
      return { ok: false, reason: failure(error) };
    }
    if (response.status !== 200) {
      const refusal = refusalReason(
        "inspect",
        response.status,
        runtimeResponseDiagnostic(response),
      );
      await response.body?.cancel().catch(() => {});
      // Re-read once per refusal, so the next tick signs with the code that now answers.
      if (refusal.codeMismatch) await follower.refused(code);
      return { ok: false, reason: refusal.reason };
    }
    let result: Record<string, unknown>;
    try {
      result = fields(fields(await response.json()).result);
    } catch (error) {
      return { ok: false, reason: `inspect-reply-${failure(error)}` };
    }
    const answered = fields(result.controllerCode);
    const controllerCode =
      text(answered.candidate) && text(answered.workerInput)
        ? `${answered.candidate}:${answered.workerInput}`
        : undefined;
    const rootResult = await rootRead(
      result.selection !== undefined && result.selection !== null,
      code,
      signal,
    );
    return { ok: true, ...(controllerCode ? { controllerCode } : {}), ...rootResult };
  };

  await writeFile(outFile, "", { mode: 0o600 });
  let samples: Sample[] = [];
  try {
    // An unrecorded first send settles which code answers, so a slow state read never sits in a sample.
    await send(stop.signal);
    samples = await probeLoop({
      send,
      signal: stop.signal,
      onSample: (sample) => appendFile(outFile, `${JSON.stringify(sample)}\n`),
    });
  } finally {
    await writeFile(outFile, samples.map((sample) => `${JSON.stringify(sample)}\n`).join(""), {
      mode: 0o600,
    });
    await Promise.race([
      bridge.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
  }
  if (stateFailure) process.stderr.write(`stage state code read failed: ${stateFailure}\n`);
  process.stdout.write(`${redact(JSON.stringify(summarize(samples)))}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2), process.env);
  } catch (error) {
    const { redactor, describeError } = await import("./redact.ts");
    process.stderr.write(`${describeError(error, redactor(process.env))}\n`);
    process.exitCode = 1;
  }
}
