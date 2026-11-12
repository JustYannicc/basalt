import { Effect, Logger, Stream } from "effect";
import type { RetainedFrameworkBucket } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";

export const moduleText = "SYNTHETIC_PRIVATE_AUTHORED_MODULE_never_return_this";
export const frameworkModules = { "node_modules/apps/server.js": "synthetic framework" };
export const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const record = (framework: { version: string; sha256: string }) => ({
  format: 2,
  mainModule: "app.js",
  modules: { "app.js": moduleText },
  framework,
  protocol: 1,
  database: false,
});
export const legacy = (format?: 1) => ({
  ...(format === undefined ? {} : { format }),
  mainModule: "app.js",
  modules: { "app.js": moduleText, ...frameworkModules },
  database: false,
});
export const metadata = (version: string, sha256: string) => ({
  key: `frameworks/${version}-${sha256}.json`,
  size: 123,
  etag: "synthetic-etag",
  uploaded: new Date("2026-11-01T00:00:00Z"),
  secret: moduleText,
});

export function bucketFixture() {
  const bodies = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const lists: unknown[] = [];
  const logs: unknown[] = [];
  let writes = 0;
  const objects: ReturnType<typeof metadata>[] = [];
  const bucket = {
    list: (
      options: Parameters<RetainedFrameworkBucket["list"]>[0],
    ): ReturnType<RetainedFrameworkBucket["list"]> =>
      Effect.sync(() => {
        lists.push(options);
        return { objects, truncated: false };
      }),
    get: (key: string): ReturnType<RetainedFrameworkBucket["get"]> =>
      Effect.sync(() => {
        reads.push(key);
        const body = bodies.get(key);
        return body === undefined ? null : { size: body.byteLength, body: Stream.make(body) };
      }),
    put: () => {
      writes++;
      throw new Error("Unexpected write");
    },
    delete: () => {
      writes++;
      throw new Error("Unexpected deletion");
    },
  } satisfies RetainedFrameworkBucket & { put: () => never; delete: () => never };
  const logger = Logger.layer([
    Logger.make((entry) => {
      logs.push(Logger.formatStructured.log(entry));
    }),
  ]);
  return { bucket, bodies, reads, lists, logs, logger, objects, writes: () => writes };
}
