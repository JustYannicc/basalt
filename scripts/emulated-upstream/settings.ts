import { maxLatencyMs, plainDecimal } from "./chaos-bounds.ts";

/**
 * The emulated upstream's one stage and the guard every run passes. The release entry deploys only
 * `test-*` stages for a stack it lists, so the stage carries that prefix; every resource the stack
 * creates is named `basalt-<stage without test->-…`, and only those are found or destroyed.
 */
export const stage = "test-emulated-upstream";
export const prefix = `basalt-${stage.replace(/^test-/u, "")}`;
export const worker = `${prefix}-gateway`;
export const container = `${prefix}-mock`;
// standard-1 (half a vCPU, 4 GiB): one instance held 2,000 concurrent 60 s streams on a full vCPU.
export const instanceType = "standard-1";
/** A deploy's lease: a proof day. The hourly expiry removes the stage once it has passed. */
export const leaseHours = 10;
/**
 * Dispatched by hand with the coordinator's go; `expire` is the schedule's own, without one.
 * `profile` sets profile b's two faults on a deployed stage, and nothing else.
 */
export const modes = ["deploy", "check", "profile", "destroy", "expire"] as const;
export type Mode = (typeof modes)[number];
export const isMode = (value: string): value is Mode => modes.some((mode) => mode === value);
const goText = /^coordinator-20\d\d-\d\d-\d\d-[A-Za-z0-9-]{1,96}$/u;
/**
 * Only these runs use the key: deploy binds it to the Worker and the mock, check and profile call
 * with it.
 */
const keyed: ReadonlyArray<Mode> = ["deploy", "check", "profile"];

/** Profile b's two faults as a profile run's inputs name them, or undefined outside the bounds. */
export function profileTarget(env: Record<string, string | undefined>) {
  const share = env.EMULATED_SHARE_429 ?? "";
  const latency = env.EMULATED_LATENCY_MS ?? "";
  if (!plainDecimal.test(share) || Number(share) > 1) return undefined;
  if (!/^(?:0|[1-9]\d{0,4})$/u.test(latency) || Number(latency) > maxLatencyMs) return undefined;
  return { rateLimitRate: Number(share), latencyMs: Number(latency) };
}
const credentials = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "EMULATED_UPSTREAM_KEY"];

/** Why a run must not go ahead, or undefined. Names what the rule expected, never the value it saw. */
export function refusal(
  env: Record<string, string | undefined>,
  { credentialsLoaded = false } = {},
) {
  if (!credentialsLoaded && credentials.some((name) => env[name] !== undefined))
    return "emulated_upstream_guard_saw_credential";
  if (env.GITHUB_ACTIONS !== "true") return "emulated_upstream_outside_actions";
  if (env.GITHUB_REF !== "refs/heads/main") return "emulated_upstream_not_main";
  if (env.EMULATED_STAGE !== stage) return "emulated_upstream_stage_refused";
  const mode = env.EMULATED_MODE ?? "";
  if (!isMode(mode))
    return "emulated_upstream_mode_expected_deploy_check_profile_destroy_or_expire";
  const scheduled = env.GITHUB_EVENT_NAME === "schedule";
  // The schedule only expires; every other mode is a person's dispatch and needs the go.
  if (scheduled && mode !== "expire") return "emulated_upstream_schedule_expected_expire";
  if (!scheduled && mode === "expire")
    return "emulated_upstream_dispatch_expected_deploy_check_profile_or_destroy";
  if (!scheduled && !goText.test(env.EMULATED_GO ?? ""))
    return "emulated_upstream_go_missing_or_malformed";
  if (mode === "profile") {
    // Profile a never has faults: the mock has no control for it.
    if (env.EMULATED_PROFILE !== "b") return "emulated_upstream_profile_expected_b";
    if (!profileTarget(env)) return "emulated_upstream_profile_settings_out_of_bounds";
    // Each setting is one written go: a re-run would set it again under the same one.
    if (env.GITHUB_RUN_ATTEMPT !== "1") return "emulated_upstream_profile_rerun_refused";
  } else if (env.EMULATED_SHARE_429 || env.EMULATED_LATENCY_MS)
    return "emulated_upstream_profile_settings_without_profile_mode";
  if (
    credentialsLoaded &&
    keyed.includes(mode) &&
    !/^[A-Za-z0-9_-]{32,128}$/u.test(env.EMULATED_UPSTREAM_KEY ?? "")
  )
    return "emulated_upstream_key_missing_or_malformed";
  return undefined;
}

export function guard(
  env: Record<string, string | undefined> = process.env,
  options: { credentialsLoaded?: boolean } = {},
) {
  const refused = refusal(env, options);
  if (refused) throw new Error(refused);
  const mode = env.EMULATED_MODE ?? "";
  if (!isMode(mode))
    throw new Error("emulated_upstream_mode_expected_deploy_check_profile_destroy_or_expire");
  return mode;
}
