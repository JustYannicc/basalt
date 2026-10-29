import { Config, Effect, Option, Redacted } from "effect";

/** Optional destinations never add an account-setup gate to the first deployment. */
export const telemetryBindings = Effect.gen(function* () {
  const result: Record<string, Redacted.Redacted<string>> = {};
  for (const name of ["SENTRY_DSN", "SENTRY_OTLP_ENDPOINT", "POSTHOG_PROJECT_KEY", "POSTHOG_HOST"]) {
    const value = yield* Config.option(Config.Redacted(name));
    if (Option.isSome(value) && Redacted.value(value.value).trim()) result[name] = value.value;
  }
  return result;
});

/**
 * Native Worker logs without query strings. Request URLs can carry sign-in codes, unsubscribe
 * links and app outbound searches, and the privacy page promises tool input stays out of logs.
 */
export const workerObservability = {
  enabled: true,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: true, persist: true },
};
