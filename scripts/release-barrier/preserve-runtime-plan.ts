import type * as Plan from "alchemy/Plan";
import { Schema } from "effect";
import { BarrierRefusal } from "./refusal.ts";

const environment = Schema.decodeUnknownSync(
  Schema.Struct({ env: Schema.Record(Schema.String, Schema.Unknown) }),
);
const names = new Set([
  "POOL_DATABASE_URL",
  "POOL_MANAGEMENT_KEY",
  "POOL_APP_SIGNING_KEY",
  "POOL_APP_SIGNING_KEY_PREVIOUS",
  "POOL_IMAGE_HASH",
  "POOL_CLAUDE_QUOTA_DIAGNOSTIC",
]);

/** Install controller code before adopting the exact settings its existing process still uses. */
export function preserveRuntimeInputs(plan: Plan.Plan) {
  const node = plan.resources.PoolWorker;
  if (!node?.state || node.action !== "update" || node.resource.Type !== "Cloudflare.Worker")
    return plan;
  const previous = node.state.status === "updating" ? node.state.old?.props : node.state.props;
  let old: ReturnType<typeof environment>;
  try {
    old = environment(previous);
  } catch {
    throw new BarrierRefusal("pool-runtime-baseline-settings-missing", "PoolWorker");
  }
  for (const name of [
    "POOL_DATABASE_URL",
    "POOL_MANAGEMENT_KEY",
    "POOL_APP_SIGNING_KEY",
    "POOL_IMAGE_HASH",
  ])
    if (old.env[name] === undefined || old.env[name] === null)
      throw new BarrierRefusal("pool-runtime-baseline-setting-missing", `PoolWorker.env.${name}`);
  const retain = (props: Record<string, unknown>) => ({
    ...props,
    env: {
      ...Object.fromEntries(
        Object.entries(environment(props).env).filter(([name]) => !names.has(name)),
      ),
      ...Object.fromEntries(Object.entries(old.env).filter(([name]) => names.has(name))),
    },
  });
  return {
    ...plan,
    resources: {
      ...plan.resources,
      PoolWorker: {
        ...node,
        props: retain(node.props),
        resource: { ...node.resource, Props: retain(node.resource.Props) },
      },
    },
  };
}
