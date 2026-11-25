/**
 * The route proof's two scratch stages and the guard every dispatch passes before any credential is
 * loaded. `test-route-scratch-1` (p2rg) runs the route gateway Durable Object against a stand-in
 * gateway image; `test-route-scratch-2` (s1380) adds an outside exit node. The release entry deploys and
 * destroys only `test-*` stages for a stack it knows, so the names carry that prefix.
 */

export const stages = ["test-route-scratch-1", "test-route-scratch-2"] as const;
export type Stage = (typeof stages)[number];
export const modes = ["deploy", "run", "destroy"] as const;
export type Mode = (typeof modes)[number];

/** Every Cloudflare resource a stage creates carries this prefix, and only those are destroyed. */
export const prefix = (stage: Stage) => `basalt-${stage.replace(/^test-/u, "")}`;
export const workerName = (stage: Stage) => `${prefix(stage)}-pool`;
export const gatewayName = (stage: Stage) => `${prefix(stage)}-route-gateway`;

/** `coordinator-YYYY-MM-DD-<text>`: the coordinator's written word for this one run. */
const goText = /^coordinator-([0-9]{4})-([0-9]{2})-([0-9]{2})-[a-z0-9][a-z0-9-]{0,62}$/u;

/** Credentials the guard must not see: it runs before any of them is loaded. */
const credentials = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

export type Refusal =
  | "route_scratch_outside_actions"
  | "route_scratch_not_main"
  | "route_scratch_stage_refused"
  | "route_scratch_mode_refused"
  | "route_scratch_go_missing"
  | "route_scratch_go_malformed"
  | "route_scratch_guard_saw_credential";

function calendarDate(year: string, month: string, day: string) {
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(`${year}-${month}-${day}`);
}

/**
 * Why a dispatch must not go ahead, or undefined. Reads the environment only; touches nothing. The
 * workflow's first guard runs before any credential is loaded; the run entry checks again with them.
 */
export function refusal(
  env: Record<string, string | undefined>,
  { credentialsLoaded = false } = {},
): Refusal | undefined {
  if (!credentialsLoaded && credentials.some((name) => env[name] !== undefined))
    return "route_scratch_guard_saw_credential";
  if (env.GITHUB_ACTIONS !== "true") return "route_scratch_outside_actions";
  if (env.GITHUB_REF !== "refs/heads/main") return "route_scratch_not_main";
  if (!stages.includes(env.ROUTE_SCRATCH_STAGE as Stage)) return "route_scratch_stage_refused";
  if (!modes.includes(env.ROUTE_SCRATCH_MODE as Mode)) return "route_scratch_mode_refused";
  const go = env.ROUTE_SCRATCH_GO ?? "";
  if (go === "") return "route_scratch_go_missing";
  const match = goText.exec(go);
  if (!match || !calendarDate(match[1]!, match[2]!, match[3]!)) return "route_scratch_go_malformed";
  return undefined;
}

/** The checked stage and mode. A refusal throws with its code only, never the value it refused. */
export function guard(
  env: Record<string, string | undefined> = process.env,
  options: { credentialsLoaded?: boolean } = {},
) {
  const refused = refusal(env, options);
  if (refused) throw new Error(refused);
  return { stage: env.ROUTE_SCRATCH_STAGE as Stage, mode: env.ROUTE_SCRATCH_MODE as Mode };
}
