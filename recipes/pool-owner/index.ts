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
import { requirements } from "../common/installation.ts";
import { configuration } from "../common/configuration.ts";
import { observe } from "../common/human.ts";
import { readPoolStatus } from "./accounts.ts";
import { retainScans } from "../common/scan-health.ts";
import { startTick } from "../common/triggers.ts";
import { storageTools } from "../common/storage.ts";

const checkMyPool = workflow(
  {
    description:
      "Check fresh capacity, account availability and distinct persistent failures. Recheck every blocking window after a capacity action.",
    input: object({ target: string(), tick: number() }),
  },
  async (ctx: WorkflowContext<typeof requirements>, input) => {
    const pool = configuration.pools.find(
      (pool) => `${pool.app}:${pool.provider}` === input.target,
    );
    if (!pool || !configuration.organization)
      return { status: "unconfigured", code: "choose-owned-pool-and-provider" };
    const link = `/org/${encodeURIComponent(configuration.organization)}/apps/${encodeURIComponent(pool.app)}?view=app`;
    return observe(
      ctx,
      `pool:${input.target}`,
      (step, previous) => readPoolStatus(step, pool.app, pool.provider, previous),
      link,
      "The selected pool provider group needs your input",
      "checkMyPool",
    );
  },
);
const tick = mutation(
  { approval: undefined, input: object({}) },
  async (ctx: MutationContext<typeof requirements>) => {
    if (configuration.pools.length > 20)
      return { status: "unconfigured", code: "bound-the-watch-list", started: 0 };
    retainScans(
      ctx,
      "checkMyPool",
      configuration.pools.map((pool) => `pool:${pool.app}:${pool.provider}`),
    );
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
