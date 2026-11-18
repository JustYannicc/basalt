import { createHash } from "node:crypto";
import { Data, Effect, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

export class LiveModuleUnavailable extends Data.TaggedError("LiveModuleUnavailable")<{
  readonly script: string;
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {}

/**
 * The sha256 of the main module the live script is serving. The class-change deploy must upload
 * exactly these bytes (R2: no code moves with the irreversible step); the wire guard compares them.
 * The content endpoint returns multipart with the module (`application/javascript+module`) and its
 * source map (recorded production shape: hunt prod-shapes 04).
 */
export const liveMainModuleSha256 = (input: {
  accountId: string;
  token: Redacted.Redacted<string>;
  script: string;
  apiOrigin?: string;
}) =>
  Effect.gen(function* () {
    const fail = (why: string, cause?: unknown) =>
      new LiveModuleUnavailable({
        script: input.script,
        why,
        fix: "Do not run the class change; read the live script again",
        ...(cause === undefined ? {} : { cause }),
      });
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const url = `${input.apiOrigin ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.script)}/content/v2`;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(Redacted.value(input.token))),
      )
      .pipe(Effect.mapError((cause) => fail("the content read failed", cause)));
    const entrypoint = response.headers["cf-entrypoint"];
    const body = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => fail("the content body could not be read", cause)),
    );
    const form = yield* Effect.tryPromise({
      try: () =>
        new Response(body, {
          headers: { "content-type": response.headers["content-type"] ?? "" },
        }).formData(),
      catch: (cause) => fail("the content is not multipart", cause),
    });
    const modules = [...form.entries()].filter(
      (entry): entry is [string, File] =>
        typeof entry[1] !== "string" && entry[1].type.startsWith("application/javascript+module"),
    );
    const main = entrypoint ? modules.filter(([name]) => name === entrypoint) : modules;
    if (main.length !== 1) return yield* fail(`expected one main module, found ${main.length}`);
    const bytes = new Uint8Array(yield* Effect.promise(() => main[0]![1].arrayBuffer()));
    return createHash("sha256").update(bytes).digest("hex");
  });
