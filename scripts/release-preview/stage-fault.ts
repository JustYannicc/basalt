/**
 * Puts a rehearsal stage's root into production's 19 Nov 2026 stuck state, then reads it back.
 *
 *   node scripts/release-preview/stage-fault.ts <lane> <outFile> [--read-only]
 *
 * Sends the signed `rehearsal-restart-over-running` command, which the controller refuses unless
 * its Worker names a `test-rehearsal-<n>` stage, then reads `inspect`, `witness` and
 * `active-health` plus the root's provider instance state, and prints them as one JSON object with
 * every id hashed. `--read-only` skips the command and only reads.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { fingerprint, refusalReason, signedHandoff, stageContext } from "./stage-probe.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const hashed = (value: unknown) => {
  const raw = text(value);
  return raw === undefined ? null : fingerprint(raw);
};

export type Reads = {
  inspect?: unknown;
  witness?: unknown;
  activeHealth: { status: number; reason?: string };
  running?: boolean;
  at: number;
};

/** The confirmed-state fields, ids hashed, and whether together they are production's stuck state. */
export function confirmedState(reads: Reads) {
  const inspected = record(reads.inspect);
  const selection = record(inspected.selection);
  const active = record(selection.active);
  const identity = record(active.identity);
  const witness = record(record(reads.witness).witness);
  const operationId = text(witness.operationId);
  const policies = (Array.isArray(inspected.policies) ? inspected.policies : []).map(record);
  const clean = policies.filter((policy) => policy.dirty === false);
  const expired = clean.filter(
    (policy) => typeof policy.expiresAt === "number" && policy.expiresAt <= reads.at,
  );
  const state = {
    selection: {
      epoch: typeof selection.epoch === "number" ? selection.epoch : null,
      fenced: typeof active.fenced === "boolean" ? active.fenced : null,
      slot: text(identity.slotId) ?? null,
      instance: hashed(identity.instanceId),
      boot: hashed(identity.bootId),
    },
    witness: {
      restart: operationId?.startsWith("restart-") ?? false,
      launch: Object.keys(record(witness.launch)).length > 0,
      operation: hashed(operationId),
      boot: hashed(witness.bootId),
    },
    // The controller's recovery record, if any: production's stuck state has none, or a clean one.
    recovery:
      inspected.recovery === undefined || inspected.recovery === null
        ? null
        : {
            keys: Object.keys(record(inspected.recovery)).sort(),
            // Plain values only (counts, flags, times); strings are hashed, nested objects named.
            values: Object.fromEntries(
              Object.entries(record(inspected.recovery)).map(([key, value]) => [
                key,
                typeof value === "number" || typeof value === "boolean" || value === null
                  ? value
                  : typeof value === "string"
                    ? hashed(value)
                    : key === "streams"
                      ? // #1471 adfb37db+: { active, stillSince }, kept by name.
                        Object.fromEntries(
                          Object.entries(record(value)).filter(
                            ([, item]) => typeof item === "number" || item === null,
                          ),
                        )
                      : "object",
              ]),
            ),
            clean: !Object.keys(record(inspected.recovery)).some((key) =>
              /fail|error|needs|refus/iu.test(key),
            ),
          },
    activeHealth: reads.activeHealth,
    container: { running: reads.running ?? null },
    policies: {
      count: policies.length,
      clean: clean.length,
      cleanExpired: expired.length,
      longestExpiredMs: expired.length
        ? Math.max(...expired.map((policy) => reads.at - Number(policy.expiresAt)))
        : null,
    },
  };
  const stuck =
    state.selection.boot !== null &&
    state.selection.fenced === false &&
    state.witness.restart &&
    state.witness.launch &&
    state.witness.boot === null &&
    (state.recovery === null || state.recovery.clean) &&
    state.container.running === true &&
    reads.activeHealth.status === 409 &&
    reads.activeHealth.reason === "runtime_endpoint_identity_slot_identity";
  return {
    ...state,
    stuck,
    policyCleanAndExpired: clean.length > 0 && expired.length === clean.length,
  };
}

/** Whether the root instance runs, from the provider's own instance list (read-only GET). */
async function rootRunning(
  accountId: string,
  token: string,
  applicationId: string,
  instanceId: string,
) {
  let page: string | undefined;
  for (let count = 0; count < 100; count++) {
    const query = new URLSearchParams({ per_page: "100", ...(page ? { page_token: page } : {}) });
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/containers/applications/${encodeURIComponent(applicationId)}/instances-v2?${query}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) },
    );
    const body = record(await response.json());
    if (!response.ok || body.success !== true)
      throw new Error(`Cloudflare instance list failed with HTTP ${response.status}`);
    const found = (Array.isArray(body.result) ? body.result : [])
      .map(record)
      .find((instance) => instance.id === instanceId);
    if (found) return record(found.status).state === "running";
    page = text(record(body.result_info).next_page_token);
    if (!page) return false;
  }
  throw new Error("Cloudflare instance list did not end");
}

async function main(args: string[], env: NodeJS.ProcessEnv) {
  const [laneText, outFile, flag] = args;
  if (!laneText || !outFile || (flag !== undefined && flag !== "--read-only"))
    throw new Error("Usage: stage-fault.ts <lane> <outFile> [--read-only]");
  const context = await stageContext("stage fault", laneText, env);
  const { key, redact, follower } = context;
  const [{ runtimeResponseDiagnostic }, { runtimeRecoveryPath }] = await Promise.all([
    import("../../src/pool/runtime-route-diagnostic.ts"),
    import("../../src/pool/recovery-approval.ts"),
  ]);
  const bridge = await context.open(await context.worker());
  const signal = AbortSignal.timeout(5 * 60_000);
  const send = (
    code: ControllerCode,
    action: string,
    extra: Record<string, unknown> = {},
    timeoutMs?: number,
  ) => signedHandoff(bridge, key, { controllerCode: code, action, ...extra }, signal, timeoutMs);
  const reason = (response: Response) => {
    const diagnostic = runtimeResponseDiagnostic(response);
    return diagnostic ? `runtime_${diagnostic.runtimeStep}_${diagnostic.runtimeReason}` : undefined;
  };
  try {
    let code = follower.current();
    if (!code) throw new Error("The stage's controller code is unavailable");
    let inspected = await send(code, "inspect");
    // A code mismatch reads as an identity refusal; follow it once, as the probe does.
    if (
      refusalReason("inspect", inspected.status, runtimeResponseDiagnostic(inspected)).codeMismatch
    ) {
      await inspected.body?.cancel();
      if (!(await follower.refused(code))) throw new Error("No controller code answers");
      code = follower.current()!;
      inspected = await send(code, "inspect");
    }
    if (inspected.status !== 200)
      throw new Error(`inspect refused: HTTP ${inspected.status} ${reason(inspected) ?? ""}`);
    await inspected.body?.cancel();
    let fault: Record<string, unknown> = { sent: false };
    if (flag !== "--read-only") {
      // Recovery's admission reads the provider inside the command, so it gets a longer budget.
      const response = await send(code, "rehearsal-restart-over-running", {}, 60_000);
      const body = record(await response.json().catch(() => ({})));
      const result = record(body.result);
      fault = {
        sent: true,
        status: response.status,
        ...(response.status === 200
          ? { operation: hashed(result.operationId), epoch: result.epoch ?? null }
          : { reason: reason(response) ?? text(body.reason) ?? null }),
      };
    }
    const after = await send(code, "inspect");
    if (after.status !== 200)
      throw new Error(`inspect refused: HTTP ${after.status} ${reason(after) ?? ""}`);
    const inspect = record(await after.json()).result;
    const target = record(record(record(inspect).selection).active).target;
    const witnessed = target ? await send(code, "witness", { target }) : undefined;
    const witness = witnessed?.status === 200 ? record(await witnessed.json()).result : undefined;
    if (witnessed && witnessed.status !== 200) await witnessed.body?.cancel();
    const health = await send(code, "active-health");
    const activeHealth = {
      status: health.status,
      ...(health.status === 200 ? {} : { reason: reason(health) }),
    };
    await health.body?.cancel();
    const identity = record(record(record(inspect).selection).active).identity;
    const applicationId = text(record(identity).applicationId);
    const instanceId = text(record(identity).instanceId);
    const running =
      applicationId && instanceId
        ? await rootRunning(
            env.CLOUDFLARE_ACCOUNT_ID ?? "",
            env.CLOUDFLARE_API_TOKEN ?? "",
            applicationId,
            instanceId,
          )
        : undefined;
    // For the controller owner: what the pool holds before any selection exists. The root's own
    // /ready is reachable only from the controller; its unsigned recovery status is the root's view.
    const readAt = Date.now();
    const rootStatus = await bridge.service
      .fetch(new Request(`http://pool-operations${runtimeRecoveryPath}`, { signal }))
      .then(async (response) => {
        const body = record(await response.json().catch(() => ({})));
        return {
          status: response.status,
          keys: Object.keys(body).sort(),
          running: typeof body.running === "boolean" ? body.running : null,
          boot: hashed(body.bootId),
          instance: hashed(body.instanceId),
        };
      })
      .catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    const view = record(inspect);
    const pool = {
      inspectKeys: Object.keys(view).sort(),
      digest: text(view.digest) ?? null,
      selectionKeys: Object.keys(record(view.selection)).sort(),
      policies: (Array.isArray(view.policies) ? view.policies : []).map((entry) => {
        const policy = record(entry);
        return {
          pool: hashed(policy.pool),
          dirty: policy.dirty ?? null,
          expiresInMs: typeof policy.expiresAt === "number" ? policy.expiresAt - readAt : null,
        };
      }),
      rootStatus,
    };
    const report = {
      stage: context.stage,
      at: new Date().toISOString(),
      fault,
      pool,
      ...confirmedState({ inspect, witness, activeHealth, running, at: readAt }),
      witnessStatus: witnessed?.status ?? null,
      modelRoute:
        "not read: needs a pool model key; production code returns 503 pool_protection_unavailable",
    };
    const stateFailure = context.stateFailure();
    if (stateFailure) process.stderr.write(`stage state code read failed: ${stateFailure}\n`);
    const line = redact(JSON.stringify(report));
    await writeFile(outFile, `${line}\n`, { mode: 0o600 });
    process.stdout.write(`${line}\n`);
  } finally {
    await Promise.race([
      bridge.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
  }
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
