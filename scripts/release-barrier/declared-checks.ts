import { Cause, Effect } from "effect";
import { BarrierRefusal, canonical } from "./manifest.ts";
import { bucketFailure } from "./bucket-failure.ts";

/** Read-only checks collect every refusal before the release can upload or mutate anything. */
export const declaredChecks = <A, E, R>(
  checks: readonly { fqn: string; check: Effect.Effect<A, E, R> }[],
  failure: (error: unknown, fqn: string) => BarrierRefusal = (error, fqn) =>
    bucketFailure(error, fqn, "prepare-bucket"),
) =>
  Effect.gen(function* () {
    const values: A[] = [];
    const failures: BarrierRefusal[] = [];
    for (const { fqn, check } of checks) {
      const result = yield* Effect.exit(check);
      if (result._tag === "Success") values.push(result.value);
      else {
        if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause);
        failures.push(failure(Cause.squash(result.cause), fqn));
      }
    }
    const refusals = [
      ...new Map(
        failures
          .flatMap((failure) => failure.refusals ?? [{ reason: failure.reason, ...failure.delta }])
          .map((refusal) => [canonical(refusal), refusal]),
      ).values(),
    ];
    const first = failures[0];
    if (first) throw new BarrierRefusal(first.reason, first.worker, first.delta, refusals);
    return values;
  });
