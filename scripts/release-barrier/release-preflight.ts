import { execFileSync } from "node:child_process";
import { assertProbeCandidate } from "../ci/probe-candidate.ts";
import { ReadinessResponseError } from "../database-budget-readiness.ts";
import { SafetyGateError } from "../deploy-safety/contracts.ts";
import { HeadroomRefusal } from "../release-phases/headroom.ts";
import { assertReadOnlyRehearsalContext } from "./release-resume-rehearsal-receipt.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import { digest } from "./manifest.ts";
import { BarrierRefusal } from "./refusal.ts";
import { ServingFailure } from "./serving-failure.ts";

export type PreflightRefusal = {
  reason: string;
  field: string | null;
  paths?: { path: string; old?: unknown; new?: unknown }[];
  serving?: { check: string; cause: string; status?: number };
  status?: number;
};

export type PreflightStepResult =
  | { step: string; status: "pass"; summary?: unknown }
  | { step: string; status: "not-applicable"; why: string }
  | { step: string; status: "refused"; refusal: PreflightRefusal }
  | { step: string; status: "skipped"; needs: string[] }
  | {
      step: string;
      status: "settlement-required";
      disposition: string;
      proof?: SettlementProofOutcome;
    };

/** Read-only counts a settlement proof added: State reads, provider GETs and bridge actions. */
export type SettlementProofReads = {
  state: { get: number; getOutput: number; writeAttempts: number } | null;
  http: { providerGets: number; stateGets: number; blockedMutations: number } | null;
  bridge: Record<string, number>;
};

/** The read-only settlement proof this candidate's preflight ran against the unsettled prior. */
export type SettlementProofOutcome =
  | {
      status: "accepted";
      disposition: string;
      source: string;
      controller: string;
      reads: SettlementProofReads;
    }
  | {
      status: "refused";
      disposition: string;
      source: string;
      refusal: PreflightRefusal;
      reads: SettlementProofReads;
    };

/**
 * The release would refuse until a settlement this candidate can perform has been applied. A
 * Check reports it; the release itself, which runs after the settlement apply, must not see it.
 */
export class SettlementRequired {
  readonly disposition: string;
  readonly proof?: SettlementProofOutcome;
  constructor(disposition: string, proof?: SettlementProofOutcome) {
    this.disposition = disposition;
    if (proof) this.proof = proof;
  }
}

/** Signals a release branch the live state does not take; the release would not call this read. */
export class NotApplicable {
  readonly why: string;
  constructor(why: string) {
    this.why = why;
  }
}

// Handoff deltas carry the server's closed refusal vocabulary and health deltas carry timings;
// other deltas may carry live values.
const closedVocabulary = (path: string) =>
  path.startsWith("handoff.") || path.startsWith("runtime-release.health.");
// Some refusals name a live identifier (an application id) as their field; those publish a digest.
const safeField = (field: string | undefined) =>
  field === undefined
    ? null
    : /^[A-Za-z_.:-]{1,120}$/u.test(field)
      ? field
      : `digest:${digest(field).slice(0, 16)}`;

/** The same safe form BarrierRefusal evidence uses: a fixed reason and the field it names. */
export function preflightRefusal(error: unknown): PreflightRefusal {
  if (error instanceof ServingFailure)
    return {
      reason: error.reason,
      field: safeField(error.worker),
      serving: {
        check: error.serving.check,
        cause: error.serving.cause,
        ...(error.serving.status === undefined ? {} : { status: error.serving.status }),
      },
    };
  if (error instanceof BarrierRefusal)
    return {
      reason: error.reason,
      field: safeField(error.worker),
      ...(error.delta
        ? {
            paths: error.delta.changed.map((change) =>
              closedVocabulary(change.path) && "old" in change
                ? { path: change.path, old: change.old, new: change.new }
                : { path: change.path },
            ),
          }
        : {}),
    };
  // Both carry fixed text written by our own gates, never a provider body.
  if (error instanceof ReadinessResponseError)
    return {
      reason: `deployment-readiness-${error.outcome ?? "refused"}`,
      field: error.stage ? `readiness.${error.stage}` : null,
      status: error.status,
    };
  if (error instanceof SafetyGateError || error instanceof HeadroomRefusal)
    return { reason: error.message, field: null };
  const failure = safeProviderFailure(error);
  return {
    reason: failure.type,
    field: null,
    ...(failure.status === undefined ? {} : { status: failure.status }),
  };
}

/**
 * Runs every step in order and records each outcome. A failed step only skips the steps that
 * need its result, so one refusal never hides a later one.
 */
export function preflightRunner() {
  const results: PreflightStepResult[] = [];
  const passed = new Set<string>();
  return {
    results,
    async step<A>(
      name: string,
      needs: readonly string[],
      run: () => Promise<A>,
      summary?: (value: A) => unknown,
    ): Promise<A | undefined> {
      const missing = needs.filter((need) => !passed.has(need));
      if (missing.length) {
        results.push({ step: name, status: "skipped", needs: missing });
        return undefined;
      }
      try {
        const value = await run();
        passed.add(name);
        results.push(
          summary
            ? { step: name, status: "pass", summary: summary(value) }
            : { step: name, status: "pass" },
        );
        return value;
      } catch (error) {
        if (error instanceof SettlementRequired) {
          results.push({
            step: name,
            status: "settlement-required",
            disposition: error.disposition,
            ...(error.proof ? { proof: error.proof } : {}),
          });
          return undefined;
        }
        if (error instanceof NotApplicable) {
          results.push({ step: name, status: "not-applicable", why: error.why });
          return undefined;
        }
        results.push({ step: name, status: "refused", refusal: preflightRefusal(error) });
        return undefined;
      }
    },
  };
}

/**
 * Production reads run only from this repository's own Actions: a same-repo PR merge pinned to
 * current main, or the main release job on its checked-out candidate.
 */
export type PreflightMode = "check" | "release";

export function assertPreflightContext(env: NodeJS.ProcessEnv, event: unknown, root: string) {
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    const context = assertReadOnlyRehearsalContext(env, event);
    if (assertProbeCandidate(root, context.head).candidate !== context.candidate)
      throw new BarrierRefusal("release-preflight-candidate-drift", "PoolWorker");
    return { candidate: context.candidate, mode: "check" as const };
  }
  const candidate = env.BASALT_RELEASE_CANDIDATE ?? "";
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REPOSITORY !== "JustYannicc/basalt" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    !/^[a-f0-9]{40}$/u.test(candidate) ||
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() !== candidate
  )
    throw new BarrierRefusal("release-preflight-untrusted-context", "PoolWorker");
  return { candidate, mode: "release" as const };
}
