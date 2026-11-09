import type { CompiledStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { Context, Effect } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import { assertSupportedPlan } from "./plan-admission.ts";
import { imagePlanReasons } from "./plan-reasons.ts";
import { ReadOnlyPlanState } from "./read-only-state.ts";
import { planStack } from "./plan-stack.ts";

/** This shares release admission without preparing uploads, images, Commands or live state. */
export const readOnlyPlan = (stack: CompiledStack) =>
  Effect.gen(function* () {
    const selected = yield* ReadOnlyPlanState;
    if (selected.stack !== stack.name || selected.stage !== stack.stage)
      throw new BarrierRefusal("read-only-plan-scope-mismatch");
    const state = yield* Context.get(stack.services, State);
    if (state !== selected.state || state.id !== "read-only-http")
      throw new BarrierRefusal("read-only-plan-state-mismatch");
    const plan = yield* planStack(stack);
    assertSupportedPlan(plan, yield* imagePlanReasons(plan));
    return { resources: Object.keys(plan.resources).length };
  });
