import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Config, Effect, Redacted } from "effect";
import type { ClassTarget, ClassContent } from "./declared-class-contract.ts";
import { classTag } from "./declared-class-contract.ts";
import { readBaseline } from "./cloudflare.ts";
import { BarrierRefusal } from "./manifest.ts";
import { encodePathSegment, withBearer, type Fetcher } from "../deploy-safety/http.ts";
import { readClassSettings } from "./class-settings.ts";

/** Version-qualified module retrieval follows Wrangler's own versions/secrets adapter. Never download the latest upload implicitly. */
export const readClassContent = (
  target: ClassTarget,
  versionId: string,
  fetcher: Fetcher = fetch,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: async (): Promise<ClassContent> => {
        const url = `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(target.accountId)}/workers/scripts/${encodePathSegment(target.scriptName)}/content/v2?version=${encodePathSegment(versionId)}`;
        const response = await fetcher(url, {
          method: "GET",
          redirect: "error",
          headers: withBearer(Redacted.value(token)),
          signal: AbortSignal.timeout(15_000),
        });
        if (
          response.status !== 200 ||
          !response.body ||
          !response.headers.get("content-type")?.startsWith("multipart/form-data") ||
          !response.headers.get("cf-entrypoint")
        ) {
          await response.body?.cancel();
          throw Object.assign(new Error("Class content unavailable"), { status: response.status });
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 16_000_000) throw new BarrierRefusal("declared-class-baseline-too-large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const form = await new Response(Buffer.concat(chunks), {
          headers: response.headers,
        }).formData();
        const files = [];
        for (const [name, file] of form) {
          if (!(file instanceof File) || file.name !== name || !file.type)
            throw new BarrierRefusal("declared-class-baseline-modules-unsupported");
          files.push({ name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
        }
        return { mainModule: response.headers.get("cf-entrypoint")!, files };
      },
      catch: (error) => error,
    });
  }).pipe(Effect.timeout("15 seconds"));

export const readDeclaredClass = (target: ClassTarget, fetcher: Fetcher = fetch) =>
  Effect.gen(function* () {
    const versions = yield* readBaseline(target);
    if (versions.length !== 1 || versions[0]!.percentage !== 100)
      throw new BarrierRefusal("declared-class-split-baseline");
    const versionId = versions[0]!.versionId;
    const version = yield* Workers.getScriptVersion({ ...target, versionId }).pipe(Retry.none);
    const settings = yield* readClassSettings(target, fetcher);
    const profile = yield* Workers.getBetaWorker({
      accountId: target.accountId,
      workerId: target.scriptName,
    }).pipe(Retry.none);
    if (typeof profile.subdomain.previewsEnabled !== "boolean")
      throw new BarrierRefusal("declared-class-preview-routing-unknown");
    const confirmed = yield* readBaseline(target);
    if (
      version.id !== versionId ||
      confirmed.length !== 1 ||
      confirmed[0]!.versionId !== versionId ||
      confirmed[0]!.percentage !== 100 ||
      !version.resources.scriptRuntime?.migrationTag ||
      classTag(settings.tags ?? []) !== version.resources.scriptRuntime.migrationTag
    )
      throw new BarrierRefusal("declared-class-live-baseline-drift");
    return {
      accountId: target.accountId,
      scriptName: target.scriptName,
      versionId,
      migrationTag: version.resources.scriptRuntime.migrationTag,
      settings,
      previewUrlsEnabled: profile.subdomain.previewsEnabled,
    };
  }).pipe(Effect.timeout("15 seconds"));

/** One exact atomic deployment. The normal provider's tag repair and retry paths are deliberately absent. */
export const deployClassExpansion = (request: Workers.PutScriptRequest) =>
  Workers.putScript(request).pipe(
    Retry.none,
    Effect.map((result) => ({
      startupTimeMs: result.startupTimeMs,
      migrationTag: result.migrationTag,
    })),
    Effect.timeout("15 seconds"),
  );

export const stageClassClone = (request: Workers.CreateBetaWorkerVersionRequest) =>
  Workers.createBetaWorkerVersion(request).pipe(
    Retry.none,
    Effect.map((result) => ({ versionId: result.id })),
    Effect.timeout("15 seconds"),
  );
export const readClassClone = (target: ClassTarget, versionId: string) =>
  Workers.getBetaWorkerVersion({
    accountId: target.accountId,
    workerId: target.scriptName,
    versionId,
    include: "modules",
  }).pipe(
    Retry.none,
    Effect.catchTag("WorkerVersionNotFound", () => Effect.succeed(undefined)),
    Effect.timeout("15 seconds"),
  );
export const deleteClassClone = (target: ClassTarget, versionId: string) =>
  Workers.deleteBetaWorkerVersion({
    accountId: target.accountId,
    workerId: target.scriptName,
    versionId,
  }).pipe(Retry.none, Effect.asVoid, Effect.timeout("15 seconds"));
