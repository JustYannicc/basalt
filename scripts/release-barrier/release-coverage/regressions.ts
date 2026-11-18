import type { Coverage } from "./steps.ts";

/**
 * Release steps that a regression test drives in the shape production had when it failed.
 * `proof` is the test file, then `#` and the test name. List a step only when the test would
 * fail if that step broke the way production did.
 */
export const regressionCoverage: readonly Coverage[] = [
  {
    step: "command:adopt",
    proof:
      "src/pool/runtime-slots-unready-pool.test.ts#a pool that is not ready does not block adopting the running runtime",
  },
  {
    step: "refusal:release-settlement-not-controller-active",
    proof:
      "scripts/release-barrier/release-settlement-controller-active.test.ts#an activated controller that never adopted its runtime is archived and lets only the named next candidate proceed",
  },
  {
    step: "refusal:release-settlement-source-controller-unproven",
    proof:
      "scripts/release-barrier/release-settlement-controller-active.test.ts#an activated controller that never adopted its runtime is archived and lets only the named next candidate proceed",
  },
  {
    step: "phase:controller",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "phase:bind-blue",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "phase:bind-green",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "phase:inactive-image",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "phase:final-settings",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "command:active-health",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "command:witness",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "command:inspect",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a first scale-out release runs every phase, retires the root runtime and is marked deployed",
  },
  {
    step: "operation:renew-asset-upload-session",
    proof:
      "scripts/release-barrier/asset-token.test.ts#a failed session renewal names its operation and activates nothing",
  },
  {
    step: "refusal:asset-completion-token-not-renewed",
    proof:
      "scripts/release-barrier/asset-token.test.ts#a renewed session that repeats a redeemed token refuses before sending the upload",
  },
  {
    step: "refusal:asset-upload-session-unavailable",
    proof:
      "scripts/release-barrier/asset-token.test.ts#an asset Worker without a renewable session refuses its second sample unsent",
  },
  {
    step: "refusal:upload-rejected-or-unconfirmed",
    proof:
      "scripts/release-barrier/regression-mcpserver-startup-reading.test.ts#one McpServer startup reading over the ceiling re-measures with fresh asset tokens and releases",
  },
  {
    step: "operation:read-worker-baseline",
    proof:
      "scripts/release-barrier/regression-read-worker-baseline-api.test.ts#the barrier reads every Worker baseline, Api first, over native fetch without a request body",
  },
  {
    step: "refusal:runtime-release-health-expired",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#release health over a bridge whose setup outlasts the health lease does not expire",
  },
  {
    step: "command:witness",
    proof:
      "scripts/release-barrier/runtime-image-release.test.ts#a controller-only release over a root an earlier controller adopted promotes a fleet primary",
  },
  {
    step: "operation:freeze-worker-upload",
    proof:
      "scripts/release-barrier/regression-script-settings-drift.test.ts#an Api numeric placement target that resolves to another region still refuses as drift",
  },
  {
    step: "refusal:script-settings-drift",
    proof:
      "scripts/release-barrier/regression-script-settings-drift.test.ts#an Api numeric placement target that resolves to another region still refuses as drift",
  },
  {
    step: "refusal:release-operation-failed",
    proof:
      "scripts/release-barrier/regression-unknown-error-type.test.ts#a native fetch baseline failure is reported with its closed HTTP client type and reason",
  },
  {
    step: "refusal:container-baseline-drift",
    proof:
      "scripts/release-barrier/container-baseline.test.ts#the recorded pre-rollout v25 baseline converges to its exact expanded v26 readback before staging a newer image",
  },
  {
    step: "refusal:new-or-unsettled-resource",
    proof:
      "scripts/release-barrier/plan-admission.test.ts#a never-completed native Command.Exec create admits only the exact readiness check",
  },
  {
    step: "refusal:unsupported-resource-update",
    proof:
      "scripts/release-barrier/prop-diff.test.ts#a provider update with unchanged props explains why instead of rendering an empty delta",
  },
  {
    step: "refusal:release-preflight-mutation-refused",
    proof:
      "scripts/release-barrier/release-preflight.test.ts#the read-only bridge refuses every mutation before it reaches the controller",
  },
  {
    step: "refusal:release-preflight-settlement-unsupported",
    proof:
      "scripts/release-barrier/release-preflight.test.ts#a required settlement reports in Check but blocks the release; an unsupported one blocks both",
  },
  {
    step: "refusal:release-settlement-active-health-expired",
    proof:
      "scripts/release-barrier/release-settlement-controller-adopted.test.ts#controller-active-adopted settlement refuses an active health whose lease expired during its own request",
  },
  {
    step: "refusal:release-settlement-active-health-identity",
    proof:
      "scripts/release-barrier/release-settlement-controller-adopted.test.ts#controller-active-adopted settlement refuses an active health for another boot",
  },
  {
    step: "refusal:release-settlement-adopted-selection-unexpected",
    proof:
      "scripts/release-barrier/release-settlement-controller-adopted.test.ts#controller-active-adopted settlement refuses an active identity that is not its target and boot",
  },
  {
    step: "refusal:release-settlement-adoption-witness-unexpected",
    proof:
      "scripts/release-barrier/release-settlement-controller-adopted.test.ts#controller-active-adopted settlement refuses a witness for another boot",
  },
  {
    step: "refusal:release-settlement-controller-identity-refused",
    proof:
      "scripts/release-barrier/release-settlement-controller-adopted.test.ts#controller-active-adopted settlement refuses a source controller code the live controller does not hold",
  },
  {
    step: "refusal:release-settlement-selection-changed",
    proof:
      "scripts/release-barrier/release-settlement-controller-adopted.test.ts#controller-active-adopted settlement refuses a selection that changed before the final inspect",
  },
];
