import { Data, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { servingVersion } from "./worker-version.ts";

/**
 * A Worker a policy admits as a code-only change must upload the bindings its serving version has.
 * This is what the wire guard compares: each binding's type and name, and what it points at that
 * can move a Durable Object class or a service (class, script, service, entrypoint). A service
 * read can name an `environment` the upload never sends, so it is not compared. Values (text, ids
 * of buckets or databases) are the plan check's to compare; secrets never are.
 */
const POINTS_AT = ["class_name", "script_name", "service", "entrypoint"] as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One line per binding, sorted. A class the script hosts itself has no script name either way. */
export const bindingShapes = (bindings: unknown, script: string): string[] =>
  (Array.isArray(bindings) ? bindings : [])
    .map((binding) => {
      const entry = record(binding) ? binding : {};
      const fields = POINTS_AT.flatMap((key) => {
        const value = entry[key];
        if (key === "script_name" && value === script) return [];
        return typeof value === "string" && value.length > 0 ? [`${key}=${value}`] : [];
      });
      return [`${String(entry.type)}`, `${String(entry.name)}`, ...fields].join(" ");
    })
    .sort();

/** The binding names whose shape differs between two shape lists, for a refusal that shows no value. */
export const differingBindings = (expected: readonly string[], actual: readonly string[]) =>
  [
    ...new Set(
      [
        ...expected.filter((shape) => !actual.includes(shape)),
        ...actual.filter((shape) => !expected.includes(shape)),
      ].map((shape) => shape.split(" ")[1] ?? "?"),
    ),
  ].sort();

export class ServingBindingsUnavailable extends Data.TaggedError("ServingBindingsUnavailable")<{
  readonly script: string;
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {}

// Lenient: a version read carries more keys than these.
const VersionRead = Schema.Struct({
  result: Schema.Struct({
    resources: Schema.Struct({ bindings: Schema.Array(Schema.Unknown) }),
  }),
});

/** The binding shapes of the version serving 100% of the script now. */
export const servingBindingShapes = (input: {
  accountId: string;
  token: Redacted.Redacted<string>;
  script: string;
  apiOrigin?: string;
}) =>
  Effect.gen(function* () {
    const fail = (why: string, cause?: unknown) =>
      new ServingBindingsUnavailable({
        script: input.script,
        why,
        fix: "Do not release this Worker as code only; read its serving version again",
        ...(cause === undefined ? {} : { cause }),
      });
    const version = yield* servingVersion(input).pipe(
      Effect.mapError((cause) => fail("the serving version could not be resolved", cause)),
    );
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const url = `${input.apiOrigin ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.script)}/versions/${encodeURIComponent(version)}`;
    const body = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(Redacted.value(input.token))),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(VersionRead)),
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) => fail("the serving version's bindings could not be read", cause)),
      );
    return bindingShapes(body.result.resources.bindings, input.script);
  });
