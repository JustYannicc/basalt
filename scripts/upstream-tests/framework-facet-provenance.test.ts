import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { Schema } from "effect";
import { compileFrameworkFixture } from "./framework-public-compiler-fixture.ts";

const upstream = resolve(".upstream");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
process.env.MINIFLARE_WORKERD_PATH ??= require("workerd").default;
const { Miniflare } = require("miniflare") as typeof import("miniflare");

const source = `
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { makeFacetSupervisor } from "@executor-js/app-data/cloudflare";
import { makeAppRunner } from "./packages/sdk/src/implementation/app-runner.ts";
export class FacetHost extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.supervisor = Effect.runPromise(makeFacetSupervisor(
      ctx, env.LOADER, () => env.MARKER,
      app => ctx.id.equals(env.DATA.idFromName(app)),
    ));
  }
  async alarm() {
    await Effect.runPromise((await this.supervisor).recover);
  }
  async fetch(request) {
    const input = await request.json();
    const supervisor = await this.supervisor;
    const runner = makeAppRunner({
      loader: this.env.LOADER,
      outbound: () => this.env.MARKER,
      credentialKey: Effect.promise(() => crypto.subtle.importKey(
        "raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])),
      data: () => supervisor,
      waitUntil: task => this.ctx.waitUntil(task),
    });
    const result = runner.invoke(input.invocation, {
      load: async () => input.loaded, elicit: null, controls: null,
    }).pipe(Effect.catch(error => Effect.succeed({ refused: error })));
    return Response.json(await Effect.runPromise(result));
  }
}
export default {
  async fetch(request, env) {
    return env.DATA.getByName("provenance-facet").fetch(request);
  },
};`;

const authored = `
import { defineApp, mutation, query, object, string, router } from "apps";
const record = mutation({ input: object({ label: string() }) }, async (ctx, input) => {
  const caller = ctx.user?.id ?? "missing";
  await fetch("https://marker.invalid/facet", { method: "POST", body: caller });
  ctx.sql.exec("INSERT INTO entries (label, caller) VALUES (?, ?)", input.label, caller);
  return caller;
});
const entries = query({ input: object({}) }, async ctx =>
  ctx.sql.exec("SELECT label, caller FROM entries ORDER BY rowid").toArray());
export default defineApp({}, { tools: router({ record, entries }) });`;

test(
  "native data facets admit compiled bytes and refuse forged lineage before authored writes",
  {
    skip:
      process.env.BASALT_CHECK_BUILT_FRAMEWORK !== "1"
        ? "The production framework build runs this proof"
        : false,
    timeout: 20_000,
  },
  async (context) => {
    const loaded = await compileFrameworkFixture(authored, [
      {
        path: "migrations/0001_entries.sql",
        content: "CREATE TABLE entries (label TEXT NOT NULL, caller TEXT NOT NULL);",
      },
    ]);
    const bundled = await build({
      stdin: {
        contents: source,
        sourcefile: "facet-host.ts",
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
      modules: [{ type: "ESModule", path: "facet.mjs", contents: bundled.outputFiles[0]!.text }],
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      durableObjects: { DATA: { className: "FacetHost", useSQLite: true } },
      serviceBindings: {
        MARKER: async (request: Request) => {
          writes.push(await request.text());
          return new Response("recorded");
        },
      },
    });
    context.after(() => runtime.dispose());
    const buildId = `bld_facet_${crypto.randomUUID()}`;
    const invoke = async (command: object, selected = loaded) => {
      const response = await runtime.dispatchFetch("https://facet.test", {
        method: "POST",
        body: JSON.stringify({
          loaded: selected,
          invocation: {
            app: "provenance-facet",
            build: selected === loaded ? buildId : `bld_refused_${crypto.randomUUID()}`,
            caller: "caller-facet",
            database: true,
            command,
            accounts: { app: {} },
            headers: {},
          },
        }),
      });
      assert.equal(response.status, 200);
      return Schema.decodeUnknownSync(
        Schema.Struct({
          ok: Schema.optionalKey(Schema.Boolean),
          value: Schema.optionalKey(Schema.Unknown),
          executorRevision: Schema.optionalKey(Schema.Int),
          refused: Schema.optionalKey(
            Schema.Struct({ _tag: Schema.String, reason: Schema.String }),
          ),
        }),
      )(await response.json());
    };
    const call = (tool: string, input: object, selected = loaded) =>
      invoke(
        { operation: "call", tool, kind: tool === "record" ? "mutation" : "query", input },
        selected,
      );
    const migrated = await invoke({ operation: "migrate" });
    assert.equal(migrated.ok, true);
    assert.equal(typeof migrated.executorRevision, "number");
    const accepted = await call("record", { label: "accepted" });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.value, "caller-facet");
    assert.equal(accepted.executorRevision, migrated.executorRevision! + 1);
    assert.deepEqual(writes, ["caller-facet"]);
    assert.ok(loaded.framework);
    const refused = await call(
      "record",
      { label: "must-not-run" },
      {
        ...loaded,
        framework: {
          ...loaded.framework,
          source: { ...loaded.framework.source, revision: "forged-facet" },
        },
      },
    );
    assert.equal(refused.refused?._tag, "FrameworkProvenanceRefused");
    assert.equal(refused.refused?.reason, "conflicting-lineage");
    assert.deepEqual(writes, ["caller-facet"]);
    const retained = await call("entries", {});
    assert.equal(retained.ok, true);
    assert.deepEqual(retained.value, [{ label: "accepted", caller: "caller-facet" }]);
  },
);
