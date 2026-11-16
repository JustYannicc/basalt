import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { FrameworkReleaseProvenance } from "../deploy-safety/framework-qualification.ts";
import { renderQualifiedFrameworkRegistry } from "../deploy-safety/framework-registry.ts";
import {
  appBridge,
  serverFilesModule,
  serverFilesSource,
} from "../../.upstream/packages/sdk/src/implementation/worker-bridge.ts";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");

const authored = `
import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, { tools: router({
  who: query({ input: object({}), output: string() }, async (ctx) => {
    const caller = ctx.user?.id ?? "missing";
    await fetch("https://marker.invalid/qualified", { method: "POST", body: caller });
    return caller;
  }),
}) });`;

/** Framework modules stay external, so retention uses the producer's exact module bytes. */
export async function registryAuthoredBundle() {
  const files = new Map([
    ["index.ts", authored],
    [serverFilesModule, serverFilesSource([{ path: "index.ts", content: authored }])],
  ]);
  const result = await build({
    stdin: { contents: appBridge, sourcefile: "app-entry.ts", resolveDir: upstream, loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
    plugins: [
      {
        name: "qualified-authored-source",
        setup(builder) {
          builder.onResolve({ filter: /^apps(?:\/.*)?$/ }, ({ path }) => ({
            path: `./node_modules/apps/${path === "apps" ? "index" : path.slice(5)}.js`,
            external: true,
          }));
          builder.onResolve({ filter: /^\.\// }, ({ path }) => {
            const name = path.slice(2);
            return files.has(name) ? { path: name, namespace: "authored" } : undefined;
          });
          builder.onLoad({ filter: /.*/, namespace: "authored" }, ({ path }) => ({
            contents: files.get(path)!,
            loader: "ts",
          }));
        },
      },
    ],
  });
  return { mainModule: "app.js", modules: { "app.js": result.outputFiles[0]!.text } };
}

const host = `
import { Effect, Option } from "effect";
import { BlobStore } from "./packages/sdk/src/contracts/blobs.ts";
import { BuildId } from "./packages/sdk/src/contracts/shared.ts";
import { retainWorkerBuild, loadWorkerBuild } from "./packages/sdk/src/implementation/worker-build-storage.ts";
import { makeAppRunner } from "./packages/sdk/src/implementation/app-runner.ts";
import { serveAppRunner } from "./packages/sdk/src/implementation/remote-app-runner.ts";
export default {
  async fetch(request, env, context) {
    const input = await request.json();
    const storage = (operation, key, body) => Effect.tryPromise(async () => {
      const response = await env.OBJECTS.fetch("https://objects.invalid/" + operation + "?key=" + encodeURIComponent(key), {
        method: body === undefined ? "GET" : "PUT", ...(body === undefined ? {} : { body }),
      });
      if (operation === "get" && response.status === 404) return Option.none();
      if (!response.ok) throw new Error("Synthetic object storage failed");
      if (operation === "exists") return (await response.text()) === "true";
      if (operation === "get") return Option.some(new Uint8Array(await response.arrayBuffer()));
    });
    const blobs = {
      get: key => storage("get", key),
      exists: key => storage("exists", key),
      put: (key, body) => storage("put", key, body),
    };
    if (input.retain) {
      const result = await Effect.runPromise(retainWorkerBuild(
        BuildId.make(input.build), { ...input.bundle, database: false, protocol: input.release.protocol },
        { version: input.release.version, modules: input.modules, provenance: input.release }, undefined,
      ).pipe(Effect.provideService(BlobStore, blobs), Effect.match({
        onSuccess: value => ({ ok: true, value }), onFailure: error => ({ ok: false, error }),
      })));
      return Response.json(result);
    }
    const runner = makeAppRunner({
      loader: env.LOADER,
      outbound: () => env.MARKER,
      credentialKey: Effect.promise(() => crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])),
      data: () => ({
        invoke: () => Effect.die("The fixture cannot invoke a data facet"),
        cache: () => Effect.die("The fixture cannot open an app cache"), cancel: () => Effect.void,
      }),
      waitUntil: task => context.waitUntil(task),
    });
    const api = serveAppRunner(runner, build => loadWorkerBuild(build).pipe(Effect.provideService(BlobStore, blobs)));
    return new Response(await Effect.runPromise(api.invoke(input.invocation, {
      elicit: null, controls: null, workflow: null,
    })), { headers: { "content-type": "application/json" } });
  },
};`;

/** Replace only the generated import; the real aggregate and Context default remain intact. */
export async function bundleRegistryRunner(
  directory: string,
  name: string,
  releases: readonly FrameworkReleaseProvenance[],
) {
  const generated = join(directory, `${name}-qualified.ts`);
  writeFileSync(generated, renderQualifiedFrameworkRegistry(releases));
  const result = await build({
    stdin: {
      contents: host,
      sourcefile: "qualified-runner.ts",
      resolveDir: upstream,
      loader: "ts",
    },
    absWorkingDir: upstream,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    external: ["cloudflare:*"],
    logLevel: "silent",
    plugins: [
      {
        name: "qualified-generated-snapshot",
        setup(builder) {
          builder.onResolve({ filter: /\/basalt-qualified-framework-releases\.ts$/ }, () => ({
            path: generated,
          }));
        },
      },
    ],
  });
  return result.outputFiles[0]!.text;
}
