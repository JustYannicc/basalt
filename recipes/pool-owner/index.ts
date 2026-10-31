import {
  defineApp,
  mutation,
  number,
  object,
  router,
  string,
  userInterval,
  workflow,
  type MutationContext,
  type WorkflowContext,
} from "apps";
import { requirements, origin } from "../common/installation.ts";
import { configuration } from "../common/configuration.ts";
import { observe } from "../common/human.ts";
import { readQuota } from "../common/reads.ts";
import { startTick } from "../common/triggers.ts";
import { storageTools } from "../common/storage.ts";

const checkMyPool = workflow(
  {
    description:
      "Confirm low or exhausted quota from two independent fresh readings. Recheck every blocking window after a capacity action.",
    input: object({ target: string(), tick: number() }),
  },
  async (ctx: WorkflowContext<typeof requirements>, input) => {
    const pool = configuration.pools.find(
      (pool) => `${pool.app}:${pool.provider}` === input.target,
    );
    if (!pool || !configuration.organization)
      return { status: "unconfigured", code: "choose-owned-pool-and-provider" };
    const link = new URL(
      `/org/${encodeURIComponent(configuration.organization)}/apps/${encodeURIComponent(pool.app)}?view=app`,
      origin,
    ).href;
    return observe(
      ctx,
      `pool:${input.target}`,
      (step, previous) => readQuota(step, pool.app, pool.provider, previous),
      link,
      "The selected pool provider group needs capacity",
    );
  },
);
const tick = mutation(
  { approval: undefined, input: object({}) },
  async (ctx: MutationContext<typeof requirements>) => {
    if (configuration.pools.length > 20)
      return { status: "unconfigured", code: "bound-the-watch-list", started: 0 };
    for (const pool of configuration.pools)
      await startTick(ctx, "checkMyPool", `${pool.app}:${pool.provider}`, 5 * 60000);
    return { status: "started", started: configuration.pools.length };
  },
);
export default defineApp(requirements, {
  tools: router({ ...storageTools, tick }),
  workflows: { checkMyPool },
  schedules: { quota: userInterval({ minutes: 5 }, tick, {}) },
});
