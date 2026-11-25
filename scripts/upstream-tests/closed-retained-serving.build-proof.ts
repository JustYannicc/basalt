import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { closedRetainedBuilds } from "../../.upstream/packages/sdk/src/implementation/closed-retained-builds.ts";
import { remoteAppRunner } from "../../.upstream/packages/sdk/src/implementation/remote-app-runner.ts";
import { compileFrameworkFixture } from "./framework-public-compiler-fixture.ts";

// These proofs read the framework bytes scripts/build.ts compiles first, and only it runs them.
assert.equal(
  process.env.BASALT_CHECK_BUILT_FRAMEWORK,
  "1",
  "Run through scripts/build.ts, which builds the framework these proofs read",
);

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");
const pool = closedRetainedBuilds.find((entry) => entry.policy === "pin-first-observation");
assert.ok(pool);
const source = `
import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { makeAppRunner, serveAppRunner } from "@executor-js/sdk/workerd";
import { makeUnverifiedRetainedBuildPin, encodePinReply, decodePinReply } from "./apps/hosted/cloud/src/implementation/unverified-retained-build-pins.ts";

export class Pins extends DurableObject {
  async fetch(request) {
    const pin = makeUnverifiedRetainedBuildPin(this.ctx.storage,
      app => this.ctx.id.equals(this.env.PINS.idFromName(app)));
    return Response.json(await Effect.runPromise(encodePinReply(pin(await request.json()))));
  }
}
export default { async fetch(request, env, context) {
  const input = await request.json();
  const pin = (app, build, tuple) => Effect.tryPromise(async () => {
    const response = await env.PINS.getByName(app).fetch(new Request("https://pins.test",{
      method:"POST",body:JSON.stringify({app,build,tuple}),
    }));
    return response.json();
  }).pipe(Effect.flatMap(reply=>decodePinReply(reply,build)));
  const runner = makeAppRunner({loader:env.LOADER,outbound:()=>env.MARKER,
    credentialKey:Effect.promise(()=>crypto.subtle.importKey("raw",new Uint8Array(32),{name:"HMAC",hash:"SHA-256"},false,["sign"])),
    data:app=>({invoke:()=>Effect.die("No data facet in this fixture"),cache:()=>Effect.die("No cache in this fixture"),cancel:()=>Effect.void,
      pinRetainedBuild:(build,tuple)=>pin(app,build,tuple)}),waitUntil:task=>context.waitUntil(task)});
  const served = serveAppRunner(runner,()=>Effect.succeed(input.loaded),pin);
  return new Response(await Effect.runPromise(input.declare === undefined
    ? served.invoke(input.invocation,{elicit:null,controls:null,workflow:null})
    : served.declare(input.declare,{})));
} };`;

test("a closed retained build serves cold and warm native calls while changed bytes and redeploy declarations refuse", async (context) => {
  const compiled =
    await compileFrameworkFixture(`import {defineApp,query,object,string,router} from "apps";
    export default defineApp({}, {tools:router({who:query({input:object({}),output:string()},async ctx=>{
      const caller=ctx.user?.id ?? "missing";await fetch("https://marker.test/entered",{method:"POST",body:caller});return caller;
    })})});`);
  const framework = compiled.framework;
  assert.ok(framework);
  const { framework: _approved, ...bundle } = compiled;
  const retained = {
    ...bundle,
    unverified: {
      _tag: "UnverifiedRetainedBuild" as const,
      app: pool.app,
      build: pool.build,
      reason: "active at sync, provenance unproven" as const,
      tuple: {
        version: framework.version,
        protocol: framework.protocol,
        sha256: framework.sha256,
      },
    },
  };
  const bundled = await build({
    stdin: {
      contents: source,
      sourcefile: "closed-serving.ts",
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
    modules: [{ type: "ESModule", path: "serving.mjs", contents: bundled.outputFiles[0]!.text }],
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    workerLoaders: { LOADER: {} },
    durableObjects: { PINS: { className: "Pins", useSQLite: true } },
    serviceBindings: {
      MARKER: async (request: Request) => {
        writes.push(await request.text());
        return new Response("recorded");
      },
    },
  });
  context.after(() => runtime.dispose());
  let selected = retained;
  const send = (body: object) =>
    Effect.tryPromise(async () => {
      const response = await runtime.dispatchFetch("https://runner.test", {
        method: "POST",
        body: JSON.stringify({ loaded: selected, ...body }),
      });
      assert.equal(response.status, 200);
      return response.text();
    });
  const remote = remoteAppRunner({
    invoke: (invocation) => send({ invocation }),
    declare: (bundle) => send({ declare: bundle }),
  });
  const invoke = (build: string, caller: string) =>
    remote.invoke(
      {
        app: pool.app,
        build,
        caller,
        database: false,
        command: { operation: "call", tool: "who", kind: "query", input: {} },
        accounts: { app: {} },
        headers: {},
      },
      { load: async () => selected, elicit: null, controls: null },
    );
  for (const caller of ["cold-caller", "warm-caller"]) {
    const reply: unknown = await Effect.runPromise(invoke(pool.build, caller));
    assert.ok(
      Schema.is(Schema.Struct({ ok: Schema.Literal(true), value: Schema.Literal(caller) }))(reply),
    );
  }
  assert.deepEqual(writes, ["cold-caller", "warm-caller"]);
  const refused = async <A, E>(operation: Effect.Effect<A, E>) => {
    const failure = await Effect.runPromise(
      operation.pipe(
        Effect.match({
          onSuccess: () => assert.fail("Unqualified invocation ran"),
          onFailure: (error) => error,
        }),
      ),
    );
    assert.ok(typeof failure === "object" && failure !== null && "_tag" in failure);
    assert.equal(failure._tag, "FrameworkProvenanceRefused");
    assert.deepEqual(writes, ["cold-caller", "warm-caller"]);
  };
  await refused(invoke("bld_unlisted_same_bytes", "unlisted-caller"));
  await refused(remote.declare(retained, {}));
  const name = Object.keys(retained.modules).find(
    (name) => name.startsWith("node_modules/apps/") && name.endsWith(".js"),
  );
  assert.ok(name);
  selected = {
    ...retained,
    modules: {
      ...retained.modules,
      [name]: `${retained.modules[name]}\n// altered retained bytes`,
    },
  };
  await refused(invoke(pool.build, "changed-warm-caller"));
});
