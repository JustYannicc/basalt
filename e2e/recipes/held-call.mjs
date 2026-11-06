import { Effect, Fiber } from "effect";

/** A missing API or early response must fail the proof instead of abandoning its held fixture. */
export const waitForHeldCall = (fiber, started, label) =>
  Effect.raceFirst(
    Effect.promise(() => started),
    Fiber.join(fiber).pipe(
      Effect.flatMap(() => Effect.fail(new Error(`${label} returned before reaching its hold`))),
    ),
  ).pipe(
    Effect.timeout("15 seconds"),
    Effect.catch((cause) =>
      Effect.fail(
        new Error(
          `${label} did not reach its hold: ${cause instanceof Error ? cause.message : (cause?._tag ?? String(cause))}`,
          { cause },
        ),
      ),
    ),
  );
