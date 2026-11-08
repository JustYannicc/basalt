import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Config, Effect, Redacted, Schema } from "effect";
import {
  encodePathSegment,
  withBearer,
  cloudflareResult,
  type Fetcher,
} from "../deploy-safety/http.ts";
import type { ClassTarget } from "./declared-class-contract.ts";
import { classConstraint, classSchemaRefusal } from "./class-refusal.ts";

const fromWire = (value: unknown, path: readonly string[] = []): unknown => {
  // These SDK fields contain caller data, not Cloudflare wire property names.
  if (
    path.length === 3 &&
    path[0] === "bindings" &&
    ["json", "algorithm", "keyJwk"].includes(path[2]!)
  )
    return value;
  if (Array.isArray(value))
    return value.map((item, index) => fromWire(item, [...path, String(index)]));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        const name = key.replace(/[_/]+(.)/gu, (_match, char: string) => char.toUpperCase());
        return [name, fromWire(item, [...path, name])];
      }),
    );
  return value;
};

/** Ordinary SDK decoding drops unknown settings. An expansion must refuse those before a full-script PUT could reset them. */
export const readClassSettings = (target: ClassTarget, fetcher: Fetcher = fetch) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetcher(
          `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(target.accountId)}/workers/scripts/${encodePathSegment(target.scriptName)}/settings`,
          {
            method: "GET",
            redirect: "error",
            headers: withBearer(Redacted.value(token)),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw Object.assign(new Error("Class settings unavailable"), { status: response.status });
        }
        const reader = response.body.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 2_000_000)
              throw classConstraint(
                "declared-class-settings-too-large",
                undefined,
                "settings.bytes",
                2_000_000,
                size,
              );
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const value = cloudflareResult(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          "class settings",
        ).result;
        try {
          return Schema.decodeUnknownSync(
            Schema.toType(Workers.GetScriptScriptAndVersionSettingResponse),
            { onExcessProperty: "error", errors: "all" },
          )(fromWire(value));
        } catch (error) {
          throw classSchemaRefusal(
            "declared-class-baseline-settings-unsupported",
            undefined,
            "settings",
            error,
          );
        }
      },
      catch: (error) => error,
    });
  }).pipe(Effect.timeout("15 seconds"));
