import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { closedRetainedBuilds } from "../../.upstream/packages/sdk/src/implementation/closed-retained-builds.ts";

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
import { Effect } from "effect";
import { makeUnverifiedRetainedBuildPin } from "./apps/hosted/cloud/src/implementation/unverified-retained-build-pins.ts";
export class Pins extends DurableObject {
  async fetch(request) {
    const input = await request.json();
    const pin = makeUnverifiedRetainedBuildPin(this.ctx.storage,
      app => this.ctx.id.equals(this.env.PINS.idFromName(app)));
    return Response.json(await Effect.runPromise(pin(input).pipe(Effect.match({
      onSuccess: pin => ({ok:true,pin}), onFailure: error => ({ok:false,error}),
    }))));
  }
}
export default { async fetch(request, env) {
  const {supervisor, ...input} = await request.json();
  return env.PINS.getByName(supervisor ?? input.app).fetch(new Request(request.url, {
    method:"POST",body:JSON.stringify(input),
  }));
} };`;

test("the real supervisor durably pins once and refuses later tuple changes and other builds", async (context) => {
  const bundled = await build({
    stdin: { contents: source, sourcefile: "closed-pins.ts", resolveDir: upstream, loader: "ts" },
    absWorkingDir: upstream,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd"],
    external: ["cloudflare:*"],
    logLevel: "silent",
  });
  const runtime = new Miniflare({
    modules: [{ type: "ESModule", path: "pins.mjs", contents: bundled.outputFiles[0]!.text }],
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { PINS: { className: "Pins", useSQLite: true } },
  });
  context.after(() => runtime.dispose());
  const pin = {
    app: pool.app,
    build: pool.build,
    tuple: { version: "synthetic-retained", protocol: 42, sha256: "1".repeat(64) },
  };
  const send = async (input: object) => {
    const reply = await runtime.dispatchFetch("https://pin.test", {
      method: "POST",
      body: JSON.stringify(input),
    });
    assert.equal(reply.status, 200);
    return reply.json() as Promise<{
      ok: boolean;
      pin?: typeof pin;
      error?: { _tag: string; comparison: string };
    }>;
  };
  assert.deepEqual(await send(pin), { ok: true, pin });
  assert.deepEqual(await send(pin), { ok: true, pin });
  for (const tuple of [
    { ...pin.tuple, version: "changed" },
    { ...pin.tuple, protocol: 41 },
    { ...pin.tuple, sha256: "2".repeat(64) },
  ]) {
    const result = await send({ ...pin, tuple });
    assert.equal(result.ok, false);
    assert.equal(result.error?._tag, "FrameworkProvenanceRefused");
  }
  assert.equal((await send({ ...pin, build: "bld_unlisted_same_tuple" })).ok, false);
  assert.equal((await send({ ...pin, supervisor: "app_another_supervisor" })).ok, false);
  assert.deepEqual(await send(pin), { ok: true, pin });

  const racing = new Miniflare({
    modules: [{ type: "ESModule", path: "pins.mjs", contents: bundled.outputFiles[0]!.text }],
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { PINS: { className: "Pins", useSQLite: true } },
  });
  context.after(() => racing.dispose());
  const race = await Promise.all(
    [pin, { ...pin, tuple: { ...pin.tuple, sha256: "2".repeat(64) } }].map(async (input) => {
      const reply = await racing.dispatchFetch("https://pin.test", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return reply.json() as Promise<{ ok: boolean; pin?: typeof pin; error?: { _tag: string } }>;
    }),
  );
  assert.equal(race.filter((result) => result.ok).length, 1, "only one first tuple can commit");
  assert.equal(
    race.filter((result) => result.error?._tag === "FrameworkProvenanceRefused").length,
    1,
  );
  const winner = race.find((result) => result.ok)?.pin;
  assert.ok(winner);
  const reply = await racing.dispatchFetch("https://pin.test", {
    method: "POST",
    body: JSON.stringify(winner),
  });
  assert.deepEqual(await reply.json(), { ok: true, pin: winner });
});
