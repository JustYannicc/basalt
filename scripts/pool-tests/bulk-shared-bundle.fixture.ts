import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import type { BundleOutput } from "alchemy/Bundle/Bundle";
import { Effect, type FileSystem, type Path } from "effect";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function sharedWorker() {
  const entry = import.meta.resolve("alchemy");
  const module = new URL(
    `Cloudflare/Workers/Sources/Rolldown${entry.endsWith(".ts") ? ".ts" : ".js"}`,
    new URL("./", entry),
  );
  const {
    WorkerBundle,
  }: {
    readonly WorkerBundle: Effect.Effect<
      {
        readonly build: (options: object) => Effect.Effect<BundleOutput, Error>;
      },
      never,
      FileSystem.FileSystem | Path.Path
    >;
  } = await import(module.href);
  const directory = await mkdtemp(join(tmpdir(), "basalt-bulk-shared-"));
  let intercepted = 0;
  let complete = false;
  try {
    const bundle = await Effect.runPromise(
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return yield* bundler.build({
          id: "BulkSharedFixture",
          main: root + "scripts/pool-tests/bulk-shared-runtime.fixture.mjs",
          compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "basalt", stage: "production" },
          extraOptions: {
            input: {
              plugins: [
                {
                  name: "bulk-shared-importable-env",
                  resolveId: {
                    order: "pre",
                    handler(source: string, importer?: string) {
                      if (
                        source !== "cloudflare:workers" ||
                        !importer ||
                        !/[/\\]cloudflare_workers\.(ts|js)$/.test(importer)
                      )
                        return null;
                      intercepted++;
                      return root + "scripts/pool-tests/bulk-shared-env.fixture.mjs";
                    },
                  },
                },
              ],
            },
            output: { dir: directory, sourcemap: false },
          },
        });
      }).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
        Effect.provide(NodeServices.layer),
      ),
    );
    assert.equal(intercepted, 1, "Only Alchemy's importable-env boundary may be adapted");
    for (const file of bundle.files) {
      if (typeof file.content !== "string") continue;
      for (const optional of ["@vitejs/devtools/config", "@alchemy.run/frontend-frameworks/core"])
        assert.ok(
          !file.content.includes(optional),
          `Infrastructure-only import survived native DCE: ${optional}`,
        );
    }
    const modules = bundle.files.map((file) => ({
      type: file.path.endsWith(".wasm") ? ("CompiledWasm" as const) : ("ESModule" as const),
      path: join(directory, file.path),
      contents: file.content,
    }));
    complete = true;
    return { modulesRoot: "/", modules };
  } finally {
    if (complete) await rm(directory, { recursive: true, force: true });
    else console.error(JSON.stringify({ proof: "shared-bundle-failure", directory }));
  }
}
