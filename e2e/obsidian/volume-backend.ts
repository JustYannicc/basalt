import { join, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { openVault } from "../../src/drive/vault.ts";
import { diskBucket, diskStorage } from "./disk-store.ts";
import { build, Miniflare } from "./runtime/index.ts";
import {
  DriveListPage,
  DriveReadResult,
  DriveSearchResult,
  DriveHistory,
  DriveWriteResult,
} from "apps/contracts";

const cacheSchema = Schema.Struct({
  bytes: Schema.Number,
  limit: Schema.Number,
  objects: Schema.Number,
  hits: Schema.Number,
  misses: Schema.Number,
  evictions: Schema.Number,
});
const usageSchema = Schema.Struct({
  currentBytes: Schema.Number,
  files: Schema.Number,
  reservedBytes: Schema.Number,
  reservedFiles: Schema.Number,
  classA: Schema.Number,
  classB: Schema.Number,
  readBytes: Schema.Number,
  retainedBytes: Schema.Number,
  reservedStorageBytes: Schema.Number,
  cache: cacheSchema,
});

export async function volumeBackend(directory: string, worker: boolean) {
  if (!worker) {
    let data = diskStorage(join(directory, "drive.sqlite"));
    const account = diskStorage(join(directory, "account.sqlite")),
      r2 = await diskBucket(join(directory, "r2"), 4_500_000_000);
    const options = {
      accountStorage: account.storage,
      bucket: r2.bucket,
      prefix: "volume/",
      cacheBytes: 2 * 1024 * 1024,
      now: () => Date.UTC(2026, 10, 7),
      limits: { classA: 20_000, classB: 1_000_000 },
    };
    const open = () => openVault({ ...options, storage: data.storage });
    return {
      kind: "node-filesystem",
      open,
      async rebuild() {
        data.close();
        data = diskStorage(join(directory, "rebuilt.sqlite"));
        return open();
      },
      async close() {
        data.close();
        account.close();
        r2.close();
      },
    };
  }
  const output = join(directory, "worker.mjs");
  await build({
    stdin: {
      contents: await readFile(new URL("./volume-worker.fixture.ts.txt", import.meta.url), "utf8"),
      resolveDir: resolve("e2e/obsidian"),
      sourcefile: "volume-worker.ts",
      loader: "ts",
    },
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    logLevel: "silent",
  });
  const runtime = new Miniflare({
    rootPath: directory,
    modulesRoot: directory,
    modules: true,
    scriptPath: output,
    compatibilityDate: "2026-07-29",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { VAULTS: { className: "VolumeVault", useSQLite: true } },
    r2Buckets: ["OBJECTS"],
    durableObjectsPersist: join(directory, "durable"),
    r2Persist: join(directory, "r2"),
  });
  const call = <A, I>(method: string, input: unknown, schema: Schema.Codec<A, I>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          runtime.dispatchFetch(`http://volume.invalid/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }),
        );
        if (!response.ok)
          throw new Error(
            `Volume worker ${method} failed (${response.status}): ${(yield* Effect.promise(() => response.text())).slice(0, 2000)}`,
          );
        const value: unknown = yield* Effect.promise(() => response.json());
        return yield* Schema.decodeUnknownEffect(schema)(value);
      }),
    );
  const open = async () => ({
    root: (await call("initialize", {}, Schema.Struct({ root: Schema.String }))).root,
    status: () => call("status", {}, usageSchema),
    clearCaches: async () => {
      await call("clear", {}, Schema.Struct({ ok: Schema.Boolean }));
    },
    service: {
      apply: (input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["apply"]>[0]) =>
        call("apply", input, DriveWriteResult),
      list: (input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["list"]>[0] = {}) =>
        call("list", input, DriveListPage),
      read: (input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["read"]>[0]) =>
        call("read", input, DriveReadResult),
      search: (input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["search"]>[0]) =>
        call("search", input, DriveSearchResult),
      history: (
        input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["history"]>[0] = {},
      ) => call("history", input, DriveHistory),
      write: (input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["write"]>[0]) =>
        call("write", input, DriveWriteResult),
      move: (input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["move"]>[0]) =>
        call("move", input, DriveWriteResult),
      restore: (
        input: Parameters<Awaited<ReturnType<typeof openVault>>["service"]["restore"]>[0],
      ) => call("restore", input, DriveWriteResult),
    },
  });
  return {
    kind: "workerd-sqlite-r2",
    open,
    async rebuild() {
      await call("rebuild", {}, Schema.Struct({ root: Schema.String }));
      return open();
    },
    close: () => runtime.dispose(),
  };
}
