import { Cause, Effect } from "effect";
import { BarrierRefusal, canonical } from "./manifest.ts";
import { classCheckFailure } from "./class-refusal.ts";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import { bucketFailure } from "./bucket-failure.ts";

type DeclaredType = DeclaredChanges["changes"][number]["type"];
const declaredCheckFailure = (
  error: unknown,
  fqn: string,
  type: DeclaredType = "Cloudflare.R2.Bucket",
) => {
  if (type === "Cloudflare.Worker") return classCheckFailure(error, fqn);
  const d1 = type === "Cloudflare.D1Database";
  return bucketFailure(
    error,
    fqn,
    d1 ? "prepare-d1" : "prepare-bucket",
    d1 ? "declared-d1-provider-failed" : "declared-bucket-provider-failed",
    type,
  );
};

/** Read-only checks collect every refusal before the release can upload or mutate anything. */
export const declaredChecks = <A, E, R>(
  checks: readonly { fqn: string; type?: DeclaredType; check: Effect.Effect<A, E, R> }[],
  failure: (
    error: unknown,
    fqn: string,
    type?: DeclaredType,
  ) => BarrierRefusal = declaredCheckFailure,
) =>
  Effect.gen(function* () {
    const values: A[] = [];
    const failures: BarrierRefusal[] = [];
    for (const { fqn, type, check } of checks) {
      const result = yield* Effect.exit(check);
      if (result._tag === "Success") values.push(result.value);
      else {
        if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause);
        failures.push(failure(Cause.squash(result.cause), fqn, type));
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
