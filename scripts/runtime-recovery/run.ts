import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { runtimeRecoveryPath, runtimeRecoveryPrefix } from "../../src/pool/runtime-recovery.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { providerPins, observedPlan, pinDrift } from "./inventory.ts";
import { recoveryPlanDigest, RecoveryWorkflowRefusal, type RecoveryPlan } from "./plan.ts";

const Receipt = Schema.Struct({
  operationId: Schema.String,
  instanceId: Schema.String,
  imageHash: Schema.String,
  release: Schema.String,
  previousBootId: Schema.String,
  status: Schema.Literals(["started", "ready", "failed"]),
  startedAt: Schema.Number,
  finishedAt: Schema.optional(Schema.Number),
  bootId: Schema.optional(Schema.String),
  failure: Schema.optional(Schema.Literals(["restart-failed", "boot-unchanged"])),
});
type Receipt = typeof Receipt.Type;
export interface RecoveryReport {
  outcome: "dry-run" | "ready" | "inspection" | "uncertain";
  plan: RecoveryPlan;
  planSha256: string;
  submissionAttempted: boolean;
  receipt?: Receipt;
  issues?: readonly { reason: string; drift: RecoveryWorkflowRefusal["drift"] }[];
}

export function recordRecoveryIssue(
  result: RecoveryReport,
  issue: RecoveryWorkflowRefusal,
): RecoveryReport {
  return {
    ...result,
    issues: [...(result.issues ?? []), { reason: issue.reason, drift: issue.drift }],
  };
}
interface Operations {
  fetch(request: Request): Promise<Response>;
}
interface Dependencies {
  operations: Operations;
  provider: () => ReturnType<typeof providerPins>;
  signingKey?: string;
  directory: string;
  now?: () => number;
}

async function responseJson(response: Response) {
  if (!response.body) throw new RecoveryWorkflowRefusal("runtime-reply-empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) throw new RecoveryWorkflowRefusal("runtime-reply-too-large");
      chunks.push(part.value);
    }
    return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } finally {
    await reader.cancel();
  }
}

export async function runReviewedRecovery(
  plan: RecoveryPlan,
  mode: "dry-run" | "apply" | "inspect",
  deps: Dependencies,
): Promise<RecoveryReport> {
  const planSha256 = recoveryPlanDigest(plan);
  let submissionAttempted = false;
  const report = (outcome: RecoveryReport["outcome"], receipt?: Receipt): RecoveryReport => ({
    outcome,
    plan,
    planSha256,
    submissionAttempted,
    ...(receipt ? { receipt } : {}),
  });
  const decodeReceipt = (value: unknown) => {
    let receipt: Receipt;
    try {
      receipt = Schema.decodeUnknownSync(Receipt)(value);
    } catch {
      throw new RecoveryWorkflowRefusal("receipt-invalid");
    }
    if (
      receipt.operationId !== plan.operationId ||
      receipt.instanceId !== plan.instanceId ||
      receipt.imageHash !== plan.imageHash ||
      receipt.release !== plan.release ||
      receipt.previousBootId !== plan.bootId
    )
      throw new RecoveryWorkflowRefusal("receipt-target-drift");
    if (receipt.bootId !== undefined && !/^[a-f0-9-]{36}$/.test(receipt.bootId))
      throw new RecoveryWorkflowRefusal("receipt-boot-invalid");
    if (receipt.status === "ready" && (!receipt.bootId || receipt.bootId === plan.bootId))
      throw new RecoveryWorkflowRefusal("receipt-boot-unchanged");
    return receipt;
  };
  const inspect = async () => {
    const response = await deps.operations.fetch(
      new Request(`http://pool-operations${runtimeRecoveryPath}?operationId=${plan.operationId}`, {
        signal: AbortSignal.timeout(15_000),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new RecoveryWorkflowRefusal(`runtime-inspection-http-${response.status}`);
    }
    return responseJson(response);
  };
  let current = await inspect();
  if (current.receipt !== undefined) return report("inspection", decodeReceipt(current.receipt));
  const marker = join(deps.directory, "submission.json");
  let submitted = false;
  try {
    const stored: unknown = JSON.parse(await readFile(marker, "utf8"));
    const valid = Schema.decodeUnknownSync(
      Schema.Struct({ operationId: Schema.String, planSha256: Schema.String }),
    )(stored);
    if (valid.operationId !== plan.operationId || valid.planSha256 !== planSha256)
      throw new RecoveryWorkflowRefusal("submission-marker-drift");
    submitted = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (mode === "inspect" || submitted) return report("uncertain");
  const check = async () => {
    const observed = observedPlan(plan, await deps.provider(), current);
    const drift = pinDrift(plan, observed);
    if (drift.length) throw new RecoveryWorkflowRefusal("pin-drift", drift);
  };
  await check();
  if (mode === "dry-run") return report("dry-run");
  if (!deps.signingKey || !/^[a-f0-9]{64}$/i.test(deps.signingKey))
    throw new RecoveryWorkflowRefusal("signing-key-unavailable");
  current = await inspect();
  if (current.receipt !== undefined) return report("inspection", decodeReceipt(current.receipt));
  await check();
  await writeFile(marker, JSON.stringify({ operationId: plan.operationId, planSha256 }), {
    flag: "wx",
    mode: 0o600,
  });
  const at = deps.now?.() ?? Date.now();
  const envelope = await signEnvelope(deps.signingKey, runtimeRecoveryPrefix, {
    version: 1,
    action: "restart-reviewed",
    operationId: plan.operationId,
    release: plan.release,
    instanceId: plan.instanceId,
    imageHash: plan.imageHash,
    bootId: plan.bootId,
    at,
    expiresAt: at + 60_000,
  });
  let receipt: Receipt;
  try {
    submissionAttempted = true;
    const response = await deps.operations.fetch(
      new Request(`http://pool-operations${runtimeRecoveryPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
        signal: AbortSignal.timeout(195_000),
      }),
    );
    if (!response.ok) {
      const body = await responseJson(response);
      const decoded = Schema.decodeUnknownOption(
        Schema.Array(
          Schema.Struct({
            property: Schema.Literals(["release", "instanceId", "imageHash", "bootId"]),
            expected: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{1,64}$/u)),
            observed: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9-]{1,64}|unavailable)$/u)),
          }),
        ),
      )(body.drift);
      const drift =
        decoded._tag === "Some"
          ? decoded.value.map((d) => ({ resource: plan.instanceId, ...d }))
          : [];
      const issue = new RecoveryWorkflowRefusal(`restart-http-${response.status}`, drift);
      if (response.status < 500) throw issue;
      try {
        const state = await inspect();
        if (state.receipt !== undefined)
          return recordRecoveryIssue(report("inspection", decodeReceipt(state.receipt)), issue);
      } catch {
        // The submission marker still prevents another POST if receipt inspection fails.
      }
      return recordRecoveryIssue(report("uncertain"), issue);
    }
    receipt = decodeReceipt(await responseJson(response));
  } catch (error) {
    if (error instanceof RecoveryWorkflowRefusal && /^restart-http-4[0-9]{2}$/.test(error.reason))
      throw error;
    const issue =
      error instanceof RecoveryWorkflowRefusal
        ? error
        : new RecoveryWorkflowRefusal("restart-reply-unconfirmed");
    // A lost or invalid POST reply permits one receipt read, never another submission.
    try {
      const state = await inspect();
      if (state.receipt !== undefined)
        return recordRecoveryIssue(report("inspection", decodeReceipt(state.receipt)), issue);
    } catch {
      /* The durable operation and local marker remain authoritative. */
    }
    return recordRecoveryIssue(report("uncertain"), issue);
  }
  if (receipt.status !== "ready" || !receipt.bootId || receipt.bootId === plan.bootId)
    return report("inspection", receipt);
  try {
    current = await inspect();
    const after = observedPlan(plan, await deps.provider(), current);
    const drift = pinDrift({ ...plan, bootId: receipt.bootId }, after);
    if (drift.length) throw new RecoveryWorkflowRefusal("post-restart-pin-drift", drift);
    return report("ready", receipt);
  } catch (error) {
    return recordRecoveryIssue(
      report("inspection", receipt),
      error instanceof RecoveryWorkflowRefusal
        ? error
        : new RecoveryWorkflowRefusal("post-restart-verification-unavailable"),
    );
  }
}
