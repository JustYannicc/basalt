import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import type { RehearsalCounters } from "./release-resume-rehearsal.ts";
import type { ReleaseSettlementProof } from "./release-settlement-contract.ts";

const calls = (counters: RehearsalCounters) => ({
  state: { ...counters.state, writesDispatched: 0 },
  http: {
    stateGetAttempts: counters.fetch.stateGetAttempts,
    stateGetCompleted: counters.fetch.stateGetCompleted,
    providerGetAttempts: counters.fetch.providerGetAttempts,
    providerGetCompleted: counters.fetch.providerGetCompleted,
    edgePreviewAuthPosts: counters.fetch.edgePreviewAuthPosts,
    edgePreviewAuthCompleted: counters.fetch.edgePreviewAuthCompleted,
  },
  runtime: {
    inspectPostDispatches: counters.runtime.inspectPostDispatches,
    inspectStatusClasses: [...counters.runtime.inspectStatusClasses],
    healthGetDispatches: counters.runtime.healthGetDispatches,
    healthStatusClasses: [...counters.runtime.healthStatusClasses],
  },
});

const mutations = (counters: RehearsalCounters, proof?: typeof ReleaseSettlementProof.Type) => ({
  state: proof?.stateWrites ?? 0,
  infrastructure: 0,
  runtime: proof?.runtimeMutations ?? 0,
  deniedStateWriteAttempts: counters.state.writeAttempts,
  blockedHttpMutationAttempts: counters.fetch.blockedMutationAttempts,
  refusedRuntimeCommands: counters.runtime.refusedNonInspectCommands,
  refusedRuntimeRequests: counters.runtime.refusedOtherRequests,
});

const countScope = {
  intercepted: [
    "StateService read/write method calls in this process",
    "parent-process global fetch and Effect FetchHttpClient calls",
    "PoolOperations service-binding requests sent by the read-only controller path",
  ],
  outsideCounter: [
    "Wrangler Node bridge startup, authentication and remote-binding internals are not observed by the parent fetch counter",
  ],
  edgePreviewPostsAreAuthenticationSessions: true,
};

export function assertReadOnlyRehearsal(
  proof: typeof ReleaseSettlementProof.Type,
  counters: RehearsalCounters,
) {
  if (
    proof.stateWrites !== 0 ||
    proof.runtimeMutations !== 0 ||
    counters.state.writeAttempts !== 0 ||
    counters.fetch.blockedMutationAttempts !== 0 ||
    counters.runtime.refusedNonInspectCommands !== 0 ||
    counters.runtime.refusedOtherRequests !== 0 ||
    counters.runtime.declaredInspectReads !== counters.runtime.inspectPostDispatches ||
    counters.runtime.declaredHealthReads !== counters.runtime.healthGetDispatches ||
    counters.runtime.inspectPostDispatches !== 1 ||
    counters.runtime.healthGetDispatches !== 1 ||
    counters.runtime.inspectControllerDigests.length !== 1 ||
    counters.runtime.inspectControllerDigests[0] !== digest(canonical(proof.controller.code))
  )
    throw new BarrierRefusal("release-rehearsal-read-only-proof-incomplete", "PoolWorker");
}

export function assertNotApplicableRehearsalReadOnly(counters: RehearsalCounters) {
  if (
    counters.state.writeAttempts !== 0 ||
    counters.fetch.blockedMutationAttempts !== 0 ||
    counters.runtime.inspectPostDispatches !== 0 ||
    counters.runtime.healthGetDispatches !== 0 ||
    counters.runtime.refusedNonInspectCommands !== 0 ||
    counters.runtime.refusedOtherRequests !== 0
  )
    throw new BarrierRefusal("release-rehearsal-not-applicable-not-read-only", "PoolWorker");
}

export function assertReadOnlyRehearsalContext(source: NodeJS.ProcessEnv, event: unknown) {
  const pullRequest =
    typeof event === "object" && event !== null ? Reflect.get(event, "pull_request") : undefined;
  const head =
    typeof pullRequest === "object" && pullRequest !== null
      ? Reflect.get(pullRequest, "head")
      : undefined;
  const base =
    typeof pullRequest === "object" && pullRequest !== null
      ? Reflect.get(pullRequest, "base")
      : undefined;
  const headRepository =
    typeof head === "object" && head !== null ? Reflect.get(head, "repo") : undefined;
  const headSha = typeof head === "object" && head !== null ? Reflect.get(head, "sha") : undefined;
  const headRepositoryName =
    typeof headRepository === "object" && headRepository !== null
      ? Reflect.get(headRepository, "full_name")
      : undefined;
  const baseRef = typeof base === "object" && base !== null ? Reflect.get(base, "ref") : undefined;
  if (
    source.GITHUB_ACTIONS !== "true" ||
    source.GITHUB_EVENT_NAME !== "pull_request" ||
    source.GITHUB_REPOSITORY !== "JustYannicc/basalt" ||
    !/^refs\/pull\/[1-9][0-9]*\/merge$/u.test(source.GITHUB_REF ?? "") ||
    !/^[a-f0-9]{40}$/u.test(source.GITHUB_SHA ?? "") ||
    headRepositoryName !== source.GITHUB_REPOSITORY ||
    baseRef !== "main" ||
    !/^[a-f0-9]{40}$/u.test(typeof headSha === "string" ? headSha : "")
  )
    throw new BarrierRefusal("release-rehearsal-untrusted-context", "PoolWorker");
  return { candidate: source.GITHUB_SHA!, head: headSha as string };
}

/** Keeps role names and digests while omitting account, worker, version and boot IDs. */
export function releaseRehearsalReceipt(input: {
  candidate: string;
  sourceCandidate: string;
  proof: typeof ReleaseSettlementProof.Type;
  counters: RehearsalCounters;
  observedAt?: string;
}) {
  const { proof, counters } = input;
  return {
    formatVersion: 1 as const,
    status: "complete" as const,
    observedAt: input.observedAt ?? new Date().toISOString(),
    candidate: input.candidate,
    sourceCandidate: input.sourceCandidate,
    proof: {
      disposition: proof.disposition,
      controllerDigest: digest(canonical(proof.controller)),
      healthDigest: digest(canonical(proof.health)),
      imageBaselineDigest: proof.imageBaselineDigest,
      nativeBeforeDigest: proof.nativeBeforeDigest,
      nativeAfterDigest: proof.nativeAfterDigest,
      nativeResources: proof.nativeResources.map(({ fqn, digest }) => ({ role: fqn, digest })),
      workers: proof.workers.map((worker) => ({
        role: worker.worker,
        baselineVersions: worker.baseline.length,
        activeVersions: worker.active.length,
        acceptedVersionPresent: worker.accepted !== null,
        placementReads: worker.placements.length,
        evidenceDigest: digest(canonical(worker)),
      })),
      applications: proof.applications.map(({ resource, digest }) => ({ role: resource, digest })),
      forwardManifest: proof.forwardManifest,
      forwardProofDigest: proof.forwardProofDigest,
    },
    calls: calls(counters),
    mutations: mutations(counters, proof),
    countScope,
  };
}

export function releaseRehearsalRefusalReceipt(input: {
  candidate?: string;
  sourceCandidate?: string;
  failure: { reason: string; type: string; status?: number };
  counters: RehearsalCounters;
}) {
  return {
    formatVersion: 1 as const,
    status: "refused" as const,
    observedAt: new Date().toISOString(),
    ...(input.candidate ? { candidate: input.candidate } : {}),
    ...(input.sourceCandidate ? { sourceCandidate: input.sourceCandidate } : {}),
    failure: input.failure,
    calls: calls(input.counters),
    mutations: mutations(input.counters),
    countScope,
  };
}

export function releaseRehearsalNotApplicableReceipt(input: {
  candidate: string;
  sourceCandidate?: string;
  reason: string;
  heads: {
    image: { state: string; digest: string | null };
    forward: { state: string; digest: string | null };
  };
  counters: RehearsalCounters;
}) {
  return {
    formatVersion: 1 as const,
    status: "not-applicable" as const,
    observedAt: new Date().toISOString(),
    candidate: input.candidate,
    ...(input.sourceCandidate ? { sourceCandidate: input.sourceCandidate } : {}),
    reason: input.reason,
    authenticatedHeadReadback: true,
    heads: input.heads,
    calls: calls(input.counters),
    mutations: mutations(input.counters),
    countScope,
  };
}
