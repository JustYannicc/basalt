import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Schema } from "effect";
import { readForwardPacket } from "./forward-model.ts";
import { journalKey } from "./forward-journal.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { decodeRuntimeReleaseHead } from "./runtime-release-journal.ts";
import { releaseImageJournalKey } from "./release-settlement-contract.ts";
import { readRuntimeProvisioningHeader } from "./provisioning-header.ts";

const ForwardHeader = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  complete: Schema.Boolean,
  sealed: Schema.Unknown,
});

type Head = {
  state: "absent" | "complete" | "aborted" | "incomplete" | "incompatible";
  candidate?: string;
  digest: string | null;
};

const headDigest = (value: unknown) => (value === undefined ? null : digest(canonical(value)));
const terminal = (head: Head) =>
  head.state === "absent" || head.state === "complete" || head.state === "aborted";

function imageHead(value: unknown, key: string): Head {
  if (value === undefined) return { state: "absent", digest: null };
  const { record } = decodeRuntimeReleaseHead(value, key);
  if (record.complete && record.abort)
    throw new BarrierRefusal("release-rehearsal-image-head-contradictory", "PoolWorker");
  if (record.abort && record.abort.status !== "aborted")
    return { state: "incompatible", candidate: record.candidate, digest: headDigest(value) };
  return {
    state: record.complete ? "complete" : record.abort ? "aborted" : "incomplete",
    candidate: record.candidate,
    digest: headDigest(value),
  };
}

function forwardHead(value: unknown, key: string): Head {
  if (value === undefined) return { state: "absent", digest: null };
  const provisioning = readRuntimeProvisioningHeader(value, key);
  if (provisioning)
    return {
      state: provisioning.record.complete ? "complete" : "incompatible",
      candidate: provisioning.record.candidate,
      digest: headDigest(value),
    };
  const header = Schema.decodeUnknownSync(ForwardHeader, { onExcessProperty: "ignore" })(value);
  const packet = readForwardPacket(
    openRecovery(header.sealed, key, header.candidate, header.manifest),
  );
  if (packet.manifest.candidate !== header.candidate)
    throw new BarrierRefusal("release-rehearsal-forward-head-identity", "PoolWorker");
  return {
    state: header.complete ? "complete" : "incomplete",
    candidate: header.candidate,
    digest: headDigest(value),
  };
}

/** Authenticates both release heads before deciding whether the old source is still resumable. */
export function inspectReleaseRehearsalSource(
  state: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
  key: string,
) {
  return Effect.gen(function* () {
    const imageKey = releaseImageJournalKey(stack);
    const forwardKey = journalKey(stack);
    const image = yield* state.getOutput(imageKey);
    const forward = yield* state.getOutput(forwardKey);
    const imageHeadValue = imageHead(image, key);
    const forwardHeadValue = forwardHead(forward, key);
    const pendingPair =
      imageHeadValue.state === "incomplete" &&
      forwardHeadValue.state === "incomplete" &&
      imageHeadValue.candidate === forwardHeadValue.candidate;
    if (!pendingPair && !(terminal(imageHeadValue) && terminal(forwardHeadValue)))
      throw new BarrierRefusal("release-rehearsal-source-pair-incomplete", "PoolWorker");
    const imageAgain = yield* state.getOutput(imageKey);
    const forwardAgain = yield* state.getOutput(forwardKey);
    if (
      headDigest(imageAgain) !== imageHeadValue.digest ||
      headDigest(forwardAgain) !== forwardHeadValue.digest
    )
      throw new BarrierRefusal("release-rehearsal-source-head-drift", "PoolWorker");
    if (pendingPair)
      return {
        disposition: "pending" as const,
        sourceCandidate: imageHeadValue.candidate!,
        image: imageHeadValue,
        forward: forwardHeadValue,
      };
    const sameCandidate =
      imageHeadValue.candidate !== undefined &&
      imageHeadValue.candidate === forwardHeadValue.candidate;
    return {
      disposition: "not-applicable" as const,
      reason:
        imageHeadValue.state === "absent" && forwardHeadValue.state === "absent"
          ? "no-release-heads"
          : "release-heads-terminal",
      ...(sameCandidate ? { sourceCandidate: imageHeadValue.candidate } : {}),
      image: imageHeadValue,
      forward: forwardHeadValue,
    };
  });
}
