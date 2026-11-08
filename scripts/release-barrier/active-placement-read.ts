import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect, Ref, Schema } from "effect";
import { HttpClient } from "effect/http";
import { BarrierRefusal } from "./manifest.ts";

const responseSchema = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({
    id: Schema.String,
    resources: Schema.Struct({
      script: Schema.optional(Schema.Struct({ placement: Schema.optional(Schema.Unknown) })),
    }),
  }),
});

/** The pinned SDK's version schema strips placement. Decode only this documented immutable metadata. */
export const readVersionPlacement = (accountId: string, scriptName: string, versionId: string) =>
  Effect.gen(function* () {
    const credentials = yield* yield* Credentials;
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const path = ["accounts", accountId, "workers", "scripts", scriptName, "versions", versionId]
      .map(encodeURIComponent)
      .join("/");
    const lastError = yield* Ref.make<unknown>(undefined);
    const retry = Retry.makeDefault(lastError);
    const read = Effect.gen(function* () {
      const response = yield* client.get(`${credentials.apiBaseUrl.replace(/\/$/, "")}/${path}`, {
        headers: formatHeaders(credentials),
      });
      const body = yield* response.json;
      const decoded = yield* Schema.decodeUnknownEffect(responseSchema)(body);
      if (decoded.result.id !== versionId)
        throw new BarrierRefusal("active-version-identity-drift");
      return { id: versionId, placement: decoded.result.resources.script?.placement };
    });
    return yield* read.pipe(
      Effect.tapError((error) => Ref.set(lastError, error)),
      Effect.retry({ while: retry.while, schedule: retry.schedule }),
    );
  });
