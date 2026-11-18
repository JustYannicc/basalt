import type { ReleaseStepId } from "./steps.ts";

/**
 * Every production release failure, with the test that reproduces it in the shape production had.
 * A proof is `file` or `file#test name`; `steps` are the release steps that failure proves.
 * `landsWith` names the change that adds a proof not merged yet: until its file exists the entry is
 * pending, and once it exists the file must declare the named test.
 */
export interface ReleaseFailure {
  readonly slug: string;
  readonly failed: string;
  readonly proof: string;
  readonly steps?: readonly ReleaseStepId[];
  readonly landsWith?: string;
}

const barrier = "scripts/release-barrier/";

export const releaseFailures: readonly ReleaseFailure[] = [
  {
    slug: "unknown-error-type",
    failed: "a baseline read failure was reported with provider type unknown",
    proof: `${barrier}regression-unknown-error-type.test.ts#a native fetch baseline failure is reported with its closed HTTP client type and reason`,
  },
  {
    slug: "read-worker-baseline-api",
    failed: "read-worker-baseline refused Api before any request was sent",
    proof: `${barrier}regression-read-worker-baseline-api.test.ts#the barrier reads every Worker baseline, Api first, over native fetch without a request body`,
  },
  {
    slug: "read-worker-baseline-publicsite",
    failed: "read-worker-baseline refused PublicSite with a persistent transport error",
    proof: `${barrier}baseline-fetch.test.ts`,
  },
  {
    slug: "get-with-body",
    failed: "the baseline GET carried the upload as its body, which native fetch refuses",
    proof: `${barrier}baseline-fetch.test.ts`,
  },
  {
    slug: "script-settings-drift-placement",
    failed:
      "freeze-worker-upload refused Api for a placement the active version resolves identically",
    proof: `${barrier}regression-script-settings-drift.test.ts#an Api region placement that the active version resolves to the same target is not drift`,
  },
  {
    slug: "script-settings-drift-subrequests",
    failed: "freeze-worker-upload refused Api for a subrequest limit the prior version dropped",
    proof: `${barrier}pending-placement.test.ts#Api limit exception requires its exact prior limit and excludes AppPages`,
  },
  {
    slug: "retirement-projection",
    failed: "the retirement projection for Api and AppPages read State with an implicit upgrade",
    proof: `${barrier}candidate-settings.test.ts`,
  },
  {
    slug: "container-empty-delta",
    failed: "a PoolContainer update was refused with an empty delta and no reason",
    proof: `${barrier}prop-diff.test.ts#a provider update with unchanged props explains why instead of rendering an empty delta`,
  },
  {
    slug: "runtime-ready-unsettled",
    failed: "a never-completed readiness Command was refused as new-or-unsettled-resource",
    proof: `${barrier}plan-admission.test.ts#a never-completed native Command.Exec create admits only the exact readiness check`,
  },
  {
    slug: "container-baseline-drift",
    failed: "a recorded pre-rollout container baseline was refused as drift",
    proof: `${barrier}container-baseline.test.ts#the recorded pre-rollout v25 baseline converges to its exact expanded v26 readback before staging a newer image`,
  },
  {
    slug: "preparation-or-provider-failed",
    failed: "a preparation failure was reported without the operation that failed",
    proof: `${barrier}deploy-stack.test.ts`,
  },
  {
    slug: "journal-format",
    failed: "a completed v2 provisioning journal head was refused by a v1-only reader",
    proof: `${barrier}forward-state-observation.test.ts#the forward probe explicitly projects completed v2 provisioning headers and rejects unknown versions`,
  },
  {
    slug: "artifact-redirect",
    failed: "restore planning turned a signed artifact redirect into a failed read",
    proof: `${barrier}journal-restore-preparation.test.ts`,
  },
  {
    slug: "mcpserver-startup-reading",
    failed: "one slow McpServer startup reading re-sent a consumed asset token",
    proof: `${barrier}regression-mcpserver-startup-reading.test.ts#one McpServer startup reading over the ceiling re-measures with fresh asset tokens and releases`,
  },
  {
    slug: "api-startup-750ms",
    failed: "Api startup measured over its budget on two of three samples",
    proof: `${barrier}regression-api-startup-750ms.test.ts#Api's application fails check:startup when most of its samples exceed Api's budget`,
  },
  {
    slug: "asset-upload-token-reuse",
    failed: "a re-upload re-sent an asset completion token the first upload consumed",
    proof: `${barrier}asset-token.test.ts#every startup sample of an asset Worker redeems its own completion token`,
  },
  {
    slug: "adopt-dirty-pool-policies",
    failed: "the runtime handoff answered adopt with 409 because existing pool policies were dirty",
    proof:
      "src/pool/runtime-slots-unready-pool.test.ts#a pool that is not ready does not block adopting the running runtime",
  },
  {
    slug: "settlement-complete-false",
    failed: "settlement read a complete forward head and failed with a SchemaError",
    proof: `${barrier}release-settlement-controller-active.test.ts#an activated controller that never adopted its runtime is archived and lets only the named next candidate proceed`,
  },
  {
    slug: "settlement-lagging-state-row",
    failed: "settlement refused because a State row still named the previous controller",
    proof: `${barrier}release-settlement-controller-active.test.ts#an activated controller that never adopted its runtime is archived and lets only the named next candidate proceed`,
  },
  {
    slug: "finalize-health-bridge-latency",
    failed: "finalize health() expired its lease on bridge setup latency",
    proof: `${barrier}runtime-image-release.test.ts#release health over a bridge whose setup outlasts the health lease does not expire`,
  },
  {
    slug: "adopted-root-witness-under-new-controller",
    failed: "selectedCurrent read the adopted root's witness under a new controller code",
    proof: `${barrier}runtime-image-release.test.ts#a controller-only release over a root an earlier controller adopted promotes a fleet primary`,
  },
  {
    slug: "preflight-live-controller-after-settlement",
    failed:
      "after a controller-active-adopted settlement the preflight inspected with the stale readiness row's controller code instead of the settlement's proof controller",
    proof: `${barrier}release-preflight-settled-controller.test.ts#after a settlement the preflight inspects with the archive's live controller code`,
    steps: ["refusal:runtime-handoff-response-refused"],
    landsWith: "fix/release-preflight-settled-controller",
  },
];
