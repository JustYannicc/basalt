import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Config, Effect, Redacted, Schema } from "effect";
import {
  encodePathSegment,
  withBearer,
  cloudflareResult,
  type Fetcher,
} from "../deploy-safety/http.ts";
import type { ClassTarget } from "./declared-class-contract.ts";
import { BarrierRefusal } from "./manifest.ts";

const fromWire = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(fromWire)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key.replace(/[_/]+(.)/gu, (_match, char: string) => char.toUpperCase()),
            fromWire(item),
          ]),
        )
      : value;

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
            if (size > 2_000_000) throw new BarrierRefusal("declared-class-settings-too-large");
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
            { onExcessProperty: "error" },
          )(fromWire(value));
        } catch {
          throw new BarrierRefusal("declared-class-baseline-settings-unsupported");
        }
      },
      catch: (error) => error,
    });
  }).pipe(Effect.timeout("15 seconds"));
