import type * as Plan from "alchemy/Plan";
import { havePropsChanged } from "alchemy/Diff";
import { State } from "alchemy/State/State";
import { Effect } from "effect";
import { BarrierRefusal } from "./manifest.ts";

/** The database selection owns its state changes; every other native record must still match preparation. */
export const verifyNativeState = (
  plan: Plan.Plan,
  stack: string,
  stage: string,
  changed: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    for (const [fqn, node] of Object.entries(plan.resources)) {
      if (changed.has(fqn)) continue;
      const current = yield* state.get({ stack, stage, fqn });
      if (havePropsChanged(current ?? {}, node.state ?? {}))
        throw new BarrierRefusal("alchemy-state-drift", fqn);
    }
  });
