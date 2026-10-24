import { Config, Effect, Option, Redacted } from "effect";

/** Optional destinations never add an account-setup gate to the first deployment. */
export const telemetryBindings = Effect.gen(function* () {
  const result: Record<string, Redacted.Redacted<string>> = {};
  for (const name of ["SENTRY_DSN", "SENTRY_OTLP_ENDPOINT", "POSTHOG_PROJECT_KEY"]) {
    const value = yield* Config.option(Config.Redacted(name));
    if (Option.isSome(value) && Redacted.value(value.value).trim()) result[name] = value.value;
  }
  return result;
});
