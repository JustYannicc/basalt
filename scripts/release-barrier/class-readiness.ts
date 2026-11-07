import type * as Plan from "alchemy/Plan";
import { State } from "alchemy/State/State";
import { Effect } from "effect";
import { classHistory } from "./class-history.ts";
import { classEntries, type ClassProvider, type ClassProgress } from "./declared-class-contract.ts";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import { assertClassObservation } from "./class-observation.ts";
import { classNative } from "./class-native.ts";
import { recordClassProgress } from "./class-recovery.ts";
import { BarrierRefusal } from "./manifest.ts";
import { withOperation } from "./operation-failure.ts";

/** Retained migration history is not current readiness. Observe the namespace again at each reliance boundary. */
export const observeClassReadiness = (
  plan: Plan.Plan,
  declarations: DeclaredChanges | undefined,
  scope: { stack: string; stage: string },
  provider: ClassProvider,
  phase: NonNullable<ClassProgress["phase"]>,
  record?: (value: ClassProgress) => Promise<void>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const history = classHistory(yield* state.getOutput(scope));
    for (const entry of classEntries(declarations)) {
      const saved = history[entry.fqn];
      const node = plan.resources[entry.fqn];
      if (!saved || saved.status !== "ready" || !node || !record)
        throw new BarrierRefusal("declared-class-prerequisite-missing", entry.fqn);
      yield* Effect.gen(function* () {
        yield* classNative(node, scope, saved);
        const observed = yield* Effect.tryPromise({
          try: () => provider.read(saved.baseline),
          catch: (error) => error,
        }).pipe(withOperation(entry.fqn, "read-class-expansion"));
        assertClassObservation(entry, saved, observed);
        yield* recordClassProgress(record, entry.fqn, { ...saved, observed }, "ready", phase);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* recordClassProgress(record, entry.fqn, saved, "not-ready", phase);
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    }
  });
