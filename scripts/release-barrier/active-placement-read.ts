import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { CloudflareHttpError, HTTP_STATUS_MAP } from "@distilled.cloud/cloudflare/Errors";
import { Duration, Effect, Ref, Schema } from "effect";
import { HttpClient } from "effect/http";
import { BarrierRefusal } from "./manifest.ts";

const responseSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: Schema.String,
    resources: Schema.Struct({
      bindings: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            type: Schema.String,
            text: Schema.optional(Schema.String),
          }),
        ),
      ),
      script: Schema.optional(Schema.Struct({ placement: Schema.optional(Schema.Unknown) })),
      script_runtime: Schema.optional(Schema.Struct({ limits: Schema.optional(Schema.Unknown) })),
    }),
  }),
});

/** The pinned SDK's version schema strips placement. Decode only the immutable placement, runtime limits and bindings needed by preparation guards. */
export const readVersionPlacement = (accountId: string, scriptName: string, versionId: string) =>
  Effect.gen(function* () {
    const credentials = yield* yield* Credentials;
    const client = yield* HttpClient.HttpClient;
    const path = ["accounts", accountId, "workers", "scripts", scriptName, "versions", versionId]
      .map(encodeURIComponent)
      .join("/");
    const lastError = yield* Ref.make<unknown>(undefined);
    const retry = Retry.makeDefault(lastError);
    const read = Effect.gen(function* () {
      const response = yield* client.get(`${credentials.apiBaseUrl.replace(/\/$/, "")}/${path}`, {
        headers: formatHeaders(credentials),
      });
      if (response.status < 200 || response.status >= 300) {
        // The default policy recognizes SDK status classes, not raw HTTP StatusCodeError.
        const ErrorClass = Object.entries(HTTP_STATUS_MAP).find(
          ([status]) => Number(status) === response.status,
        )?.[1];
        const message = "Immutable Worker version read failed";
        const error = ErrorClass
          ? new ErrorClass({ message })
          : new CloudflareHttpError({ status: response.status, statusText: "", message });
        const hint = response.headers["retry-after"];
        const delay =
          hint === undefined
            ? NaN
            : /^\d+(?:\.\d+)?$/.test(hint)
              ? Number(hint) * 1000
              : Date.parse(hint) - Date.now();
        yield* response.text.pipe(Effect.ignore);
        return yield* Effect.fail(
          Object.assign(error, {
            status: response.status,
            ...(Number.isFinite(delay) && delay >= 0 ? { retryAfter: Duration.millis(delay) } : {}),
          }),
        );
      }
      const body = yield* response.json;
      const decoded = yield* Schema.decodeUnknownEffect(responseSchema)(body);
      if (decoded.result.id !== versionId)
        throw new BarrierRefusal("active-version-identity-drift");
      return {
        id: versionId,
        placement: decoded.result.resources.script?.placement,
        bindings: decoded.result.resources.bindings?.filter(
          (binding) => binding.name === "POOL_IMAGE_HASH",
        ),
        ...(decoded.result.resources.script_runtime?.limits === undefined
          ? {}
          : { limits: decoded.result.resources.script_runtime.limits }),
      };
    });
    return yield* read.pipe(
      Effect.tapError((error) => Ref.set(lastError, error)),
      Effect.retry({ while: retry.while, schedule: retry.schedule }),
    );
  });
