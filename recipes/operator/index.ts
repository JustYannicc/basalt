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
  type WorkflowStepContext,
} from "apps";
import { requirements } from "../common/installation.ts";
import { configuration } from "../common/configuration.ts";
import { observe } from "../common/human.ts";
import {
  readAvailability,
  readErrorSpike,
  readRelease,
  readRuntime,
  readServiceErrors,
  readWorkflowHealth,
} from "./reads.ts";
import type { Checkpoint, Observation } from "../common/types.ts";
import { startTick } from "../common/triggers.ts";
import { storageTools } from "../common/storage.ts";

const input = object({ target: string(), tick: number() });
const page = () => `/org/${encodeURIComponent(configuration.organization)}/apps`;
function check(
  description: string,
  read: (
    step: WorkflowStepContext<typeof requirements>,
    previous: Checkpoint,
  ) => Promise<Observation>,
) {
  return workflow(
    { input, description },
    async (ctx: WorkflowContext<typeof requirements>, value) => {
      if (!configuration.organization)
        return { status: "unconfigured", code: "organization-required" };
      return observe(ctx, `production:${value.target}`, read, page(), description);
    },
  );
}
const checkProductionRelease = check(
  "Review the failed production release and its existing release gates",
  readRelease,
);
const checkPoolRuntime = check("Review the shared pool runtime and verify readiness", readRuntime);
const checkServiceErrors = check(
  "Review the sustained production HTTP error rate",
  readServiceErrors,
);
const checkPublicAvailability = check(
  "Review public routing and an authenticated backend read",
  readAvailability,
);
const checkErrorSpike = check("Review the production error-event spike", readErrorSpike);
const checkWorkflowHealth = check(
  "Review the failed configured check workflow",
  readWorkflowHealth,
);
const checkProductionCapacity = workflow({ input }, async () => ({
  status: "unconfigured",
  code: "complete-authorized-capacity-inventory-required",
}));
const checkServiceBudget = workflow({ input }, async () => ({
  status: "unconfigured",
  code: "approved-budget-and-billing-source-required",
}));
const tick = mutation(
  { approval: undefined, input: object({}) },
  async (ctx: MutationContext<typeof requirements>) => {
    for (const name of ["checkPoolRuntime", "checkServiceErrors", "checkPublicAvailability"])
      await startTick(ctx, name, name, 60000);
    return { started: 3 };
  },
);
const slowTick = mutation(
  { approval: undefined, input: object({}) },
  async (ctx: MutationContext<typeof requirements>) => {
    for (const name of ["checkProductionRelease", "checkErrorSpike", "checkWorkflowHealth"])
      await startTick(ctx, name, name, 5 * 60000);
    return { started: 3 };
  },
);
export default defineApp(requirements, {
  tools: router({ ...storageTools, tick, slowTick }),
  workflows: {
    checkProductionRelease,
    checkPoolRuntime,
    checkServiceErrors,
    checkPublicAvailability,
    checkErrorSpike,
    checkWorkflowHealth,
    checkProductionCapacity,
    checkServiceBudget,
  },
  schedules: {
    runtime: userInterval({ minutes: 1 }, tick, {}),
    production: userInterval({ minutes: 5 }, slowTick, {}),
  },
});
