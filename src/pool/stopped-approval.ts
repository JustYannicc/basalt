import { Schema } from "effect";
import { AutomaticSample } from "./automatic-recovery.ts";
import {
  LaunchTarget,
  launchGeneration,
  launchOperationId,
  LaunchRefused,
} from "./launch-contract.ts";
import { runtimeRecoveryPrefix } from "./recovery-approval.ts";
import { openEnvelope } from "./token.ts";

export const StoppedApproval = Schema.Struct({
  version: Schema.Literal(1),
  action: Schema.Literal("start-stopped"),
  operationId: launchOperationId,
  target: LaunchTarget,
  generation: launchGeneration,
  at: Schema.Int,
  expiresAt: Schema.Int,
  selection: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  samples: Schema.Array(AutomaticSample),
});
export type StoppedApproval = typeof StoppedApproval.Type;

export function validateStoppedApproval(value: unknown, now: number) {
  const approval = Schema.decodeUnknownSync(StoppedApproval, { onExcessProperty: "error" })(value);
  if (
    !Number.isSafeInteger(approval.at) ||
    !Number.isSafeInteger(approval.expiresAt) ||
    approval.at < 0 ||
    approval.at > now + 5_000 ||
    approval.expiresAt <= now ||
    approval.expiresAt <= approval.at ||
    approval.expiresAt > approval.at + 60_000
  )
    throw new LaunchRefused("approval-expired");
  const samples = approval.samples;
  if (
    samples.length !== 3 ||
    samples.some(
      (sample) => sample.condition !== "stopped" || sample.selection !== approval.selection,
    )
  )
    throw new LaunchRefused("stopped-evidence-invalid");
  if (samples[2]!.at > now || now - samples[2]!.at > 30_000)
    throw new LaunchRefused("stopped-evidence-stale");
  for (let i = 1; i < samples.length; i++) {
    const elapsed = samples[i]!.at - samples[i - 1]!.at;
    if (elapsed < 60_000 || elapsed > 90_000) throw new LaunchRefused("stopped-evidence-gap");
  }
  return approval;
}

export async function decodeStoppedApproval(secret: string, envelope: string, now = Date.now()) {
  return validateStoppedApproval(await openEnvelope(secret, runtimeRecoveryPrefix, envelope), now);
}

export async function stoppedSelection(target: LaunchTarget, generation: number) {
  const canonical = [
    ...Object.keys(LaunchTarget.fields)
      .sort()
      .map((key) => [key, target[key as keyof LaunchTarget]]),
    ["generation", generation],
  ];
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
