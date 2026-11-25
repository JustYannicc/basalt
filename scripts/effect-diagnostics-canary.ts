import { Effect, Schema } from "effect";

// Deliberate violations the gate expects on every run. If one goes unreported, something has
// silenced Effect's diagnostics for Basalt's code. Nothing imports this file.
export const floating = Effect.gen(function* () {
  Effect.log("canary");
});

export const untyped = Effect.tryPromise({
  try: () => Promise.resolve(1),
  catch: (error) => error,
});

export const thrown = Schema.decodeUnknownSync(Schema.String)("canary");

export const global = Effect.fail(new Error("canary"));
