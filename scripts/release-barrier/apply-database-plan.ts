import * as Apply from "alchemy/Apply";
import type * as Plan from "alchemy/Plan";
import { Effect } from "effect";
import { withStateOperations } from "./observed-state.ts";
import { withOperation } from "./operation-failure.ts";

/** Observe the already-admitted plan without changing providers, actions or retry policy. */
export const applyDatabasePlan = (plan: Plan.Plan) =>
  Apply.apply({
    ...plan,
    resources: Object.fromEntries(
      Object.entries(plan.resources).map(([fqn, node]) => {
        const provider = node.provider;
        const precreate = provider.precreate;
        return [
          fqn,
          {
            ...node,
            provider: {
              ...provider,
              ...(precreate
                ? {
                    precreate: (input: Parameters<typeof precreate>[0]) =>
                      Effect.suspend(() => precreate(input)).pipe(
                        withOperation(fqn, "apply-database-resource"),
                      ),
                  }
                : {}),
              reconcile: (input: Parameters<typeof provider.reconcile>[0]) =>
                Effect.suspend(() => provider.reconcile(input)).pipe(
                  withOperation(fqn, "apply-database-resource"),
                ),
            },
          },
        ];
      }),
    ),
  }).pipe(
    withStateOperations("apply-read-state", "apply-write-state"),
    withOperation("(database)", "apply-database-plan"),
  );
