import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";

export function serialized() {
  const semaphore = Semaphore.makeUnsafe(1);
  return async <T>(use: () => Promise<T>): Promise<T> => {
    const result = await Effect.runPromiseExit(
      semaphore.withPermit(Effect.tryPromise({ try: use, catch: (error) => error })),
    );
    if (Exit.isSuccess(result)) return result.value;
    throw Cause.squash(result.cause);
  };
}
