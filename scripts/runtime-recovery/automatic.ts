import { createHash } from "node:crypto";
import { Schema } from "effect";
import { AutomaticSample, automaticEvidence } from "../../src/pool/automatic-recovery.ts";
import { canonical, hash } from "../production-ops/artifact.ts";
import { RecoveryPlan, RecoveryWorkflowRefusal, type RecoveryPlan as Plan } from "./plan.ts";
import { observedPlan, pinDrift, type providerPins } from "./inventory.ts";
import { responseJson } from "./run.ts";

const { operationId: _operationId, ...targetFields } = RecoveryPlan.fields;
export const AutomaticTarget = Schema.Struct({
  ...targetFields,
  pool: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,511}$/u)),
});
export type AutomaticTarget = typeof AutomaticTarget.Type;
export const automaticTargetDigest = (target: AutomaticTarget) => hash(`${canonical(target)}\n`);
export function reviewedAutomaticTarget(text: string, digest: string) {
  try {
    if (Buffer.byteLength(text) > 16_384 || !/^[a-f0-9]{64}$/.test(digest)) throw new Error();
    const target = Schema.decodeUnknownSync(AutomaticTarget, { onExcessProperty: "error" })(
      JSON.parse(text),
    );
    if (automaticTargetDigest(target) !== digest) throw new Error();
    return target;
  } catch {
    throw new RecoveryWorkflowRefusal("automatic-target-invalid");
  }
}

/** A workflow rerun derives the same operation; a fresh run cannot reuse an uncertain permit. */
export function automaticOperationId(runId: string, selection: string) {
  if (!/^[1-9][0-9]{0,19}$/.test(runId)) throw new RecoveryWorkflowRefusal("workflow-run-invalid");
  const bytes = createHash("sha256").update(`${runId}:${selection}`).digest();
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const AutomaticEvidence = Schema.Struct({
  selection: Schema.String,
  pool: Schema.String,
  samples: Schema.Array(AutomaticSample),
});
interface Dependencies {
  operations: { fetch(request: Request): Promise<Response> };
  provider: () => ReturnType<typeof providerPins>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function collectAutomaticEvidence(
  target: AutomaticTarget,
  plan: Plan,
  deps: Dependencies,
) {
  const selection = automaticTargetDigest(target);
  const samples: AutomaticSample[] = [];
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let index = 0; index < 3; index++) {
    if (index > 0) await sleep(60_000);
    const [providerRead, observationRead] = await Promise.allSettled([
      deps.provider(),
      deps.operations.fetch(
        new Request(
          `http://pool-operations/automatic-recovery-observation?pool=${encodeURIComponent(target.pool)}`,
          { signal: AbortSignal.timeout(25_000) },
        ),
      ),
    ]);
    if (observationRead.status === "rejected")
      throw new RecoveryWorkflowRefusal("automatic-observation-unavailable");
    const response = observationRead.value;
    if (providerRead.status === "rejected") {
      await response.body?.cancel();
      throw providerRead.reason;
    }
    const provider = providerRead.value;
    if (!response.ok) {
      await response.body?.cancel();
      throw new RecoveryWorkflowRefusal(`automatic-observation-http-${response.status}`);
    }
    const observation = Schema.decodeUnknownSync(
      Schema.Struct({
        enabled: Schema.Boolean,
        runtime: Schema.Unknown,
        condition: AutomaticSample.fields.condition,
      }),
    )(await responseJson(response));
    if (!observation.enabled) throw new RecoveryWorkflowRefusal("automatic-target-disabled");
    const drift = pinDrift(plan, observedPlan(plan, provider, observation.runtime));
    if (drift.length) throw new RecoveryWorkflowRefusal("pin-drift", drift);
    samples.push({ at: now(), selection, condition: observation.condition });
    if (observation.condition !== "view-transport")
      throw new RecoveryWorkflowRefusal("automatic-human-required");
  }
  const decision = automaticEvidence(samples, now());
  if (decision !== "eligible") throw new RecoveryWorkflowRefusal(`automatic-${decision}`);
  return { selection, pool: target.pool, samples };
}
