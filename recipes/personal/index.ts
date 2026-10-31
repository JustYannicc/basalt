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
import { readConnection, connectionTargets } from "../common/reads.ts";
import { retainScans } from "../common/scan-health.ts";
import { startTick } from "../common/triggers.ts";
import { storageTools } from "../common/storage.ts";

const checkMyConnections = workflow(
  {
    description:
      "A current native check can ask the credential owner to reconnect or review permissions. Temporary errors stay quiet.",
    input: object({ target: string(), tick: number() }),
  },
  async (ctx: WorkflowContext<typeof requirements>, input) => {
    const organization = configuration.organization;
    if (!organization) return { status: "unconfigured", code: "organization-required" };
    const link = `/org/${encodeURIComponent(organization)}/accounts?account=${encodeURIComponent(input.target)}`;
    return observe(
      ctx,
      `account:${input.target}`,
      (step) => readConnection(step, input.target),
      link,
      "A connection needs your input",
      "checkMyConnections",
    );
  },
);
const tick = mutation(
  { approval: undefined, input: object({}) },
  async (ctx: MutationContext<typeof requirements>) => {
    const targets = await connectionTargets(ctx);
    if (targets.length > 100)
      return { status: "unconfigured", code: "bound-the-watch-list", started: 0 };
    retainScans(
      ctx,
      "checkMyConnections",
      targets.map((target) => `account:${target}`),
    );
    for (const target of targets) await startTick(ctx, "checkMyConnections", target, 30 * 60000);
    return { status: "started", started: targets.length };
  },
);
export default defineApp(requirements, {
  tools: router({ ...storageTools, tick }),
  workflows: { checkMyConnections },
  schedules: { connections: userInterval({ minutes: 30 }, tick, {}) },
});
