import { Cause, Effect } from "effect";
import { BarrierRefusal } from "./manifest.ts";
import { bucketFailure } from "./bucket-failure.ts";

/** Read-only checks collect every refusal before the release can upload or mutate anything. */
export const declaredChecks = <A, E, R>(
  checks: readonly { fqn: string; check: Effect.Effect<A, E, R> }[],
) =>
  Effect.gen(function* () {
    const values: A[] = [];
    const failures: BarrierRefusal[] = [];
    for (const { fqn, check } of checks) {
      const result = yield* Effect.exit(check);
      if (result._tag === "Success") values.push(result.value);
      else {
        if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause);
        failures.push(bucketFailure(Cause.squash(result.cause), fqn, "prepare-bucket"));
      }
    }
    const first = failures[0];
    if (first)
      throw new BarrierRefusal(
        first.reason,
        first.worker,
        first.delta,
        failures.flatMap(
          (failure) => failure.refusals ?? [{ reason: failure.reason, ...failure.delta }],
        ),
      );
    return values;
  });
