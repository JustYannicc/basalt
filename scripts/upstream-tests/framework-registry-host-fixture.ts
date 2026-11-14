import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import type { FrameworkReleaseProvenance } from "../deploy-safety/framework-qualification.ts";
import { renderQualifiedFrameworkRegistry } from "../deploy-safety/framework-registry.ts";

const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");

const host = `
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { BlobStore } from "./packages/sdk/src/contracts/blobs.ts";
import { BuildId } from "./packages/sdk/src/contracts/shared.ts";
import { admitLoadedFramework } from "./packages/sdk/src/implementation/framework-provenance.ts";
import { retainWorkerBuild, loadStoredWorkerBuild, loadWorkerFramework, linkWorkerBuild,
  inlinedBuildKey, encodeJson } from "./packages/sdk/src/implementation/worker-build-storage.ts";
import { InlinedWorkerBuild } from "./packages/sdk/src/contracts/worker-build.ts";
const input = JSON.parse(readFileSync(0, "utf8"));
mkdirSync(input.store, { recursive: true });
const path = (key) => join(input.store, createHash("sha256").update(key).digest("hex"));
const blobs = {
  get: (key) => Effect.sync(() => existsSync(path(key)) ? Option.some(new Uint8Array(readFileSync(path(key)))) : Option.none()),
  exists: (key) => Effect.sync(() => existsSync(path(key))),
  put: (key, body) => Effect.sync(() => writeFileSync(path(key), body)),
};
const program = Effect.gen(function* () {
  const id = BuildId.make(input.id);
  if (input.action === "retain") {
    yield* retainWorkerBuild(id, {
      mainModule: "app.js", modules: { "app.js": "export default {};" },
      database: false, protocol: input.release.protocol,
    }, { version: input.release.version, modules: input.modules, provenance: input.release }, undefined);
    yield* blobs.put(yield* inlinedBuildKey(BuildId.make(input.id + "_inlined")), yield* encodeJson(InlinedWorkerBuild, {
      format: 1, mainModule: "app.js", modules: { ...input.modules, "app.js": "export default {};" },
      database: false, protocol: input.release.protocol,
    }));
    return { retained: true };
  }
  const stored = yield* loadStoredWorkerBuild(id);
  const loaded = yield* linkWorkerBuild(stored, (identity) => loadWorkerFramework(identity, id), id);
  const claimed = input.forged ? { ...loaded, framework: { ...loaded.framework, source: { ...loaded.framework.source, revision: "forged" } } } : loaded;
  yield* admitLoadedFramework(claimed, { build: id });
  return { format: stored.format, framework: loaded.framework };
});
const result = await Effect.runPromise(program.pipe(
  Effect.provideService(BlobStore, blobs),
  Effect.match({ onSuccess: (value) => ({ ok: true, value }), onFailure: (error) => ({ ok: false, error }) }),
));
console.log(JSON.stringify(result));
`;

/** Compile the real default registry against a physical generated snapshot, then start it afresh. */
export async function buildRegistryHost(
  directory: string,
  name: string,
  releases: readonly FrameworkReleaseProvenance[],
) {
  const generated = join(directory, `${name}-qualified.ts`);
  writeFileSync(generated, renderQualifiedFrameworkRegistry(releases));
  const output = join(directory, `${name}-host.mjs`);
  await build({
    stdin: { contents: host, sourcefile: "registry-host.ts", resolveDir: resolve(".upstream") },
    absWorkingDir: resolve(".upstream"),
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: output,
    logLevel: "silent",
    plugins: [
      {
        name: "qualified-snapshot",
        setup(builder) {
          builder.onResolve({ filter: /\/basalt-qualified-framework-releases\.ts$/ }, () => ({
            path: generated,
          }));
        },
      },
    ],
  });
  return output;
}
