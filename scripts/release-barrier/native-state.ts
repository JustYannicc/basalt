import type * as Plan from "alchemy/Plan";
import { havePropsChanged } from "alchemy/Diff";
import { State } from "alchemy/State/State";
import { Effect } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import { operationFailure, withOperation } from "./operation-failure.ts";
import { changedProps } from "./prop-diff.ts";

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
      const current = yield* state
        .get({ stack, stage, fqn })
        .pipe(withOperation(fqn, "read-native-state"));
      if (havePropsChanged(current ?? {}, node.state ?? {}))
        throw operationFailure(
          new BarrierRefusal("alchemy-state-drift", fqn, {
            fqn,
            type: node.resource.Type,
            changed: changedProps(node.state ?? {}, current ?? {}),
          }),
          fqn,
          "verify-native-state",
        );
    }
  });
