import { createHash } from "node:crypto";
import { Data, Effect, Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { servingVersion } from "./worker-version.ts";

// A Worker script is at most 10 MB compressed; this bounds the read well above any real one.
const contentLimit = 64_000_000;

export class LiveModuleUnavailable extends Data.TaggedError("LiveModuleUnavailable")<{
  readonly script: string;
  readonly why: string;
  readonly fix: string;
  readonly cause?: unknown;
}> {}

/**
 * The sha256 of the main module the live script is serving. The class-change deploy must upload
 * exactly these bytes, so no code moves with the step that cannot be rolled back; the wire guard
 * compares them. The latest upload is not necessarily what serves (a version can be uploaded
 * without being deployed), so the read names the one version serving 100%. The content endpoint
 * returns multipart: the module (`application/javascript+module`) and its source map.
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
    const version = yield* servingVersion(input).pipe(
      Effect.mapError((cause) => fail("the serving version could not be resolved", cause)),
    );
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const url = `${input.apiOrigin ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(input.accountId)}/workers/scripts/${encodeURIComponent(input.script)}/content/v2?version=${encodeURIComponent(version)}`;
    const response = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(Redacted.value(input.token))),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) => fail("the content read failed", cause)),
      );
    const entrypoint = response.headers["cf-entrypoint"];
    const body = yield* response.arrayBuffer.pipe(
      Effect.timeout("15 seconds"),
      Effect.mapError((cause) => fail("the content body could not be read", cause)),
    );
    if (body.byteLength > contentLimit)
      return yield* fail(`the content is ${body.byteLength} bytes, over ${contentLimit}`);
    const form = yield* Effect.tryPromise({
      try: () =>
        new Response(body, {
          headers: { "content-type": response.headers["content-type"] ?? "" },
        }).formData(),
      catch: (cause) => fail("the content is not multipart", cause),
    });
    // The entrypoint header names the main module, whatever media type the uploader gave its part
    // (an Alchemy upload carries no `+module` type). Without the header, only a lone script will do.
    const files = [...form.entries()].filter(
      (entry): entry is [string, File] => typeof entry[1] !== "string",
    );
    const main = entrypoint
      ? files.filter(([name]) => name === entrypoint)
      : files.filter(([, file]) => /javascript/u.test(file.type));
    if (main.length !== 1) return yield* fail(`expected one main module, found ${main.length}`);
    const bytes = new Uint8Array(yield* Effect.promise(() => main[0]![1].arrayBuffer()));
    return createHash("sha256").update(bytes).digest("hex");
  });
