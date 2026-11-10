import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { FrameworkProvenanceRefused } from "../../.upstream/packages/sdk/src/contracts/runtime.ts";
import type { LoadedWorkerBuild } from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";
import { approvedFrameworkReleases } from "../../.upstream/packages/sdk/src/implementation/basalt-framework-releases.ts";
import {
  appBridge,
  serverFilesModule,
  serverFilesSource,
} from "../../.upstream/packages/sdk/src/implementation/worker-bridge.ts";
import { remoteAppRunner } from "../../.upstream/packages/sdk/src/implementation/remote-app-runner.ts";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");

const hostSource = `
import { Effect } from "effect";
import { makeAppRunner } from "./packages/sdk/src/implementation/app-runner.ts";
import { serveAppRunner } from "./packages/sdk/src/implementation/remote-app-runner.ts";
export default {
  async fetch(request, env, context) {
    const input = await request.json();
    const runner = makeAppRunner({
      // An evicted app has cold code while this host still holds its validated protocol cache.
      loader: input.cold ? { get: (_name, load) => env.LOADER.get(null, load) } : env.LOADER,
      outbound: () => env.MARKER,
      credentialKey: Effect.promise(() => crypto.subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])),
      data: () => ({
        invoke: () => Effect.die("The stateless fixture cannot invoke a data facet"),
        cache: () => Effect.die("The stateless fixture cannot open a cache"),
        cancel: () => Effect.void,
      }),
      waitUntil: (task) => context.waitUntil(task),
    });
    const api = serveAppRunner(runner, () => Effect.succeed(input.loaded));
    const result = input.declare === undefined
      ? api.invoke(input.invocation, { elicit: null, controls: null, workflow: null })
      : api.declare(input.declare, {});
    return new Response(await Effect.runPromise(result), { headers: { "content-type": "application/json" } });
  },
};`;

const authored = `
import { defineApp, query, object, string, router } from "apps";
export default defineApp({}, { tools: router({
  who: query({ input: object({}), output: string() }, async (ctx) => {
    const caller = ctx.user?.id ?? "missing";
    await fetch("https://marker.invalid/entered", { method: "POST", body: caller });
    return caller;
  }),
}) });`;

async function appBundle(): Promise<LoadedWorkerBuild> {
  const runtime = JSON.parse(
    readFileSync(
      process.env.BASALT_FRAMEWORK_FIXTURE ?? resolve(upstream, "packages/apps/dist/runtime.json"),
      "utf8",
    ),
  );
  const framework = approvedFrameworkReleases.find(
    (release) => release.version === runtime.version,
  );
  assert.ok(framework, "The current framework requires reviewed publication evidence");
  const virtual = new Map([
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
        name: "retained-app-source",
        setup(builder) {
          builder.onResolve({ filter: /^apps(?:\/.*)?$/ }, ({ path }) => ({
            path: `./node_modules/apps/${path === "apps" ? "index" : path.slice(5)}.js`,
            external: true,
          }));
          builder.onResolve({ filter: /^\.\// }, ({ path }) => {
            const name = path.slice(2);
            return virtual.has(name) ? { path: name, namespace: "authored" } : undefined;
          });
          builder.onLoad({ filter: /.*/, namespace: "authored" }, ({ path }) => ({
            contents: virtual.get(path)!,
            loader: "ts",
          }));
        },
      },
    ],
  });
  return {
    mainModule: "app.js",
    modules: { "app.js": result.outputFiles[0]!.text, ...runtime.server },
    protocol: runtime.protocol,
    framework,
  };
}

test(
  "native remote declarations and cold/warm calls admit real bytes and refuse altered builds before authored writes",
  {
    skip:
      process.env.BASALT_CHECK_BUILT_FRAMEWORK !== "1"
        ? "The production framework build runs this proof"
        : false,
    timeout: 20_000,
  },
  async (context) => {
    const loaded = await appBundle();
    const bundled = await build({
      stdin: {
        contents: hostSource,
        sourcefile: "provenance-host.ts",
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
    });
    const writes: string[] = [];
    const runtime = new Miniflare({
      modules: [
        { type: "ESModule", path: "provenance-host.mjs", contents: bundled.outputFiles[0]!.text },
      ],
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      serviceBindings: {
        MARKER: async (request: Request) => {
          writes.push(await request.text());
          return new Response("recorded");
        },
      },
    });
    context.after(() => runtime.dispose());
    let selected = loaded;
    let cold = false;
    const send = (body: object) =>
      Effect.tryPromise(async () => {
        const reply = await runtime.dispatchFetch("https://runner.test", {
          method: "POST",
          body: JSON.stringify({ loaded: selected, cold, ...body }),
        });
        assert.equal(reply.status, 200);
        return reply.text();
      });
    const remote = remoteAppRunner({
      invoke: (invocation) => send({ invocation }),
      declare: (bundle) => send({ declare: bundle }),
    });
    const declaration = await Effect.runPromise(remote.declare(loaded, {}));
    assert.ok(
      Schema.is(Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }))(declaration),
    );
    assert.deepEqual(writes, []);
    const invoke = (build: string, caller: string) =>
      remote.invoke(
        {
          app: "provenance-fixture",
          build,
          caller,
          database: false,
          command: { operation: "call", tool: "who", kind: "query", input: {} },
          accounts: { app: {} },
          headers: {},
        },
        { load: async () => selected, elicit: null, controls: null },
      );
    const buildId = `bld_native_${crypto.randomUUID()}`;
    for (const caller of ["caller-cold", "caller-warm"]) {
      const result = await Effect.runPromise(invoke(buildId, caller));
      assert.ok(
        Schema.is(Schema.Struct({ ok: Schema.Literal(true), value: Schema.Literal(caller) }))(
          result,
        ),
      );
    }
    assert.deepEqual(writes, ["caller-cold", "caller-warm"]);
    const { framework } = loaded;
    assert.ok(framework);
    const { framework: _framework, ...withoutFramework } = loaded;
    const cases: Array<[LoadedWorkerBuild, FrameworkProvenanceRefused["reason"]]> = [
      [withoutFramework, "missing-identity"],
      [
        {
          ...loaded,
          protocol: 14,
          framework: { ...framework, version: "0.0.1-beta.122", protocol: 14 },
        },
        "unknown-identity",
      ],
      [
        {
          ...loaded,
          framework: { ...framework, source: { ...framework.source, revision: "forged" } },
        },
        "conflicting-lineage",
      ],
      [
        { ...loaded, modules: { ...loaded.modules, "node_modules/apps/index.js": "corrupt" } },
        "content-mismatch",
      ],
      [{ ...loaded, protocol: 14 }, "protocol-mismatch"],
    ];
    for (const [invalid, reason] of cases) {
      selected = invalid;
      const result = await Effect.runPromise(
        invoke(`bld_refused_${crypto.randomUUID()}`, "must-not-run").pipe(
          Effect.match({
            onSuccess: () => assert.fail("Invalid framework ran authored code"),
            onFailure: (error) => error,
          }),
        ),
      );
      assert.ok(Schema.is(FrameworkProvenanceRefused)(result));
      assert.equal(result.reason, reason);
      assert.deepEqual(writes, ["caller-cold", "caller-warm"]);
    }
    cold = true;
    selected = {
      ...loaded,
      framework: { ...framework, source: { ...framework.source, revision: "warm-replacement" } },
    };
    const refused = await Effect.runPromise(
      invoke(buildId, "warm-must-not-run").pipe(
        Effect.match({
          onSuccess: () => assert.fail("Warm replacement ran authored code"),
          onFailure: (error) => error,
        }),
      ),
    );
    assert.ok(Schema.is(FrameworkProvenanceRefused)(refused));
    assert.equal(refused.reason, "conflicting-lineage");
    assert.equal(refused.build, buildId);
    assert.deepEqual(writes, ["caller-cold", "caller-warm"]);
  },
);
