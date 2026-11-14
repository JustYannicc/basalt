import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { Effect, Redacted, Schema, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { filesystemBlobStore, workerdApps } from "../../.upstream/packages/sdk/src/node-workerd.ts";
import { bundleWorkerdHost } from "../../.upstream/packages/sdk/src/implementation/workerd-bundle.ts";
import { RevisionEvent } from "../../.upstream/packages/app-data/src/contracts/change-revisions.ts";

// SDK exports point to source checked with upstream's exactOptionalPropertyTypes. Keeping this
// runtime integration in JS avoids checking app-cache under the root's different schema types.
const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare");
const key = { topic: "accounts", resource: "*" };
const scope = "organization:team-a";
const otherScope = "organization:team-b";
const current = (revision) => ({
  kind: "current",
  revisions: [{ ...key, revision }],
  snapshotRequired: true,
});
const changed = (revision) => ({ kind: "changed", hint: { ...key, revision } });

test(
  "the actual Node workerd host publishes scoped committed changes and retains heads across reconnect",
  { timeout: 120_000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "self-host-committed-changes-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* workerdApps({
              directory: join(directory, "workerd"),
              blobs: filesystemBlobStore({ directory: join(directory, "blobs") }),
              executor: Effect.die("notification transport must not invoke the executor"),
              encryptionKey: Redacted.make("a".repeat(64)),
            });
            const changes = host.committedChanges;
            yield* Effect.scoped(
              Effect.gen(function* () {
                const pull = yield* Stream.toPull(
                  changes.subscribe(scope, [key]).pipe(Stream.rechunk(1)),
                );
                const other = yield* Stream.toPull(
                  changes.subscribe(otherScope, [key]).pipe(Stream.rechunk(1)),
                );
                assert.deepEqual(yield* pull, [current("0")]);
                assert.deepEqual(yield* other, [current("0")]);
                yield* changes.publish(otherScope, { ...key, revision: "9" });
                yield* changes.publish(scope, { ...key, revision: "1" });
                assert.deepEqual(
                  yield* pull,
                  [changed("1")],
                  "another organization cannot reach this subscription",
                );
                assert.deepEqual(yield* other, [changed("9")]);
                yield* changes.publish(scope, { topic: "apps", resource: "*", revision: "7" });
                yield* changes.publish(scope, { ...key, revision: "2" });
                assert.deepEqual(
                  yield* pull,
                  [changed("2")],
                  "unrequested topics cannot reach this subscription",
                );
              }),
            );
            yield* changes.publish(scope, { ...key, revision: "3" });
            yield* changes.publish(scope, { ...key, revision: "1" });
            yield* Effect.scoped(
              Effect.gen(function* () {
                const resumed = yield* Stream.toPull(
                  changes.subscribe(scope, [key]).pipe(Stream.rechunk(1)),
                );
                assert.deepEqual(
                  yield* resumed,
                  [current("3")],
                  "a stale publish cannot rewind the durable head",
                );
              }),
            );
          }),
        ),
        { signal: context.signal },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

// This runs the production binding adapter inside a Worker, as the packaged product does.
const consumerSource = `
import { Effect, Exit, Scope, Stream } from 'effect';
import { bindingWorkerdApps } from './packages/sdk/src/implementation/binding-workerd-apps.ts';
const unused = () => Effect.die('notification transport must not access app blobs');
const blobs = { get:unused, exists:unused, put:unused, remove:unused, list:unused, stream:unused };
export default { async fetch(request, env) {
  const lifetime = Scope.makeUnsafe();
  let phase = 'binding acquisition';
  try {
    const host = await Effect.runPromise(bindingWorkerdApps({
      binding:env.APPS, authorization:'fixture-private', blobs,
    }).pipe(Effect.provideService(Scope.Scope,lifetime)));
    if (request.method === 'POST') {
      phase = 'publication';
      const {scope,hint} = await request.json();
      await Effect.runPromise(host.committedChanges.publish(scope,hint));
      await Effect.runPromise(Scope.close(lifetime,Exit.void));
      return new Response(null,{status:204});
    }
    phase = 'subscription';
    const url = new URL(request.url);
    const events = host.committedChanges.subscribe(url.searchParams.get('scope'),JSON.parse(url.searchParams.get('keys')));
    return new Response(Stream.toReadableStream(events.pipe(
      Stream.onExit(exit => Scope.close(lifetime,exit)),
      Stream.map(event => JSON.stringify(event)+'\\n'), Stream.encodeText,
    )),{headers:{'content-type':'application/x-ndjson'}});
  } catch (error) {
    await Effect.runPromise(Scope.close(lifetime,Exit.void));
    return new Response(JSON.stringify({phase,error:String(error).slice(0,2048)}),{
      status:500,headers:{'content-type':'application/json'},
    });
  }
}};`;

async function bindingRuntime(directory) {
  const consumerRoot = join(directory, "consumer");
  const appsRoot = join(directory, "apps");
  const hostModules = await Effect.runPromise(
    bundleWorkerdHost.pipe(Effect.provide(NodeServices.layer)),
  );
  const consumer = await build({
    stdin: {
      contents: consumerSource,
      resolveDir: new URL("../../.upstream", import.meta.url).pathname,
      loader: "ts",
    },
    outdir: consumerRoot,
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2023",
    conditions: ["workerd"],
    external: ["cloudflare:*"],
    loader: { ".wasm": "copy" },
  });
  return new Miniflare({
    workers: [
      {
        name: "consumer",
        modulesRoot: consumerRoot,
        modules: [...consumer.outputFiles]
          .sort((a, b) => Number(a.path.endsWith(".wasm")) - Number(b.path.endsWith(".wasm")))
          .map((file) => ({
            type: file.path.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
            path: file.path,
            contents: file.contents,
          })),
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: { APPS: "apps" },
      },
      {
        name: "apps",
        modulesRoot: appsRoot,
        modules: hostModules.map((module) => {
          assert.ok(module.type === "ESModule" || module.type === "Wasm");
          return {
            type: module.type === "Wasm" ? "CompiledWasm" : "ESModule",
            path: join(appsRoot, module.name),
            contents: module.content,
          };
        }),
        compatibilityDate: "2026-07-30",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          AUTH: "fixture-private",
          CREDENTIAL_SECRET: "synthetic-credential-secret",
          APPS_PRIVATE_FETCH: false,
          SELF_ORIGIN: "",
          NPM_REGISTRY: "",
        },
        durableObjects: { DATA: { className: "AppDataSupervisor", useSQLite: true } },
        workerLoaders: { LOADER: {} },
      },
    ],
  });
}

async function assertStatus(response, expected) {
  if (response.status === expected) return;
  let body = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (body.length < 4096) {
        const result = await reader.read();
        if (result.done) break;
        body += decoder.decode(result.value).slice(0, 4096 - body.length);
      }
    } finally {
      await reader.cancel();
    }
  }
  assert.equal(response.status, expected, `binding fixture response: ${body}`);
}

async function subscribe(runtime, owner = scope) {
  const response = await runtime.dispatchFetch(
    `https://fixture/events?scope=${encodeURIComponent(owner)}&keys=${encodeURIComponent(JSON.stringify([key]))}`,
  );
  await assertStatus(response, 200);
  assert.ok(response.body, "the subscription must have a streaming response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    cancel: () => reader.cancel(),
    async next() {
      while (!pending.includes("\n")) {
        const result = await reader.read();
        assert.equal(result.done, false, "the binding closed before delivering its event");
        pending += decoder.decode(result.value, { stream: true });
      }
      const end = pending.indexOf("\n");
      const event = Schema.decodeUnknownSync(Schema.fromJsonString(RevisionEvent))(
        pending.slice(0, end),
      );
      pending = pending.slice(end + 1);
      return event;
    },
  };
}

test(
  "the packaged binding transport reaches the actual AppDataSupervisor and reconnects with its retained head",
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "binding-committed-changes-"));
    let runtime;
    try {
      runtime = await bindingRuntime(directory);
      const publish = async (owner, hint) => {
        await assertStatus(
          await runtime.dispatchFetch("https://fixture/publish", {
            method: "POST",
            body: JSON.stringify({ scope: owner, hint }),
          }),
          204,
        );
      };
      const first = await subscribe(runtime);
      const other = await subscribe(runtime, otherScope);
      try {
        assert.deepEqual(
          await first.next(),
          current("0"),
          "the initial handshake cannot be lost before socket.accept",
        );
        assert.deepEqual(await other.next(), current("0"));
        await publish(otherScope, { ...key, revision: "9" });
        await publish(scope, { ...key, revision: "1" });
        assert.deepEqual(await first.next(), changed("1"));
        assert.deepEqual(await other.next(), changed("9"));
        await publish(scope, { topic: "apps", resource: "*", revision: "7" });
        await publish(scope, { ...key, revision: "2" });
        assert.deepEqual(await first.next(), changed("2"));
      } finally {
        await first.cancel();
        await other.cancel();
      }
      await publish(scope, { ...key, revision: "3" });
      await publish(scope, { ...key, revision: "1" });
      const resumed = await subscribe(runtime);
      try {
        assert.deepEqual(await resumed.next(), current("3"));
      } finally {
        await resumed.cancel();
      }
    } finally {
      await runtime?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
