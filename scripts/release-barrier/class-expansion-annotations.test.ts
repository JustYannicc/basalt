import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { ConfigProvider, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { readClassClone, readDeclaredClass, stageClassClone } from "./class-cloudflare.ts";
import { expansionContent, expansionRequest } from "./class-payload.ts";
import { assertClone, cloneRequest } from "./class-clone.ts";
import { baselineKey, classAnnotations } from "./class-settings.ts";
import type { ClassRecord } from "./class-history.ts";
import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import { BarrierRefusal, canonical } from "./manifest.ts";
import {
  productionDeploymentsBody,
  productionProfileBody,
  productionScriptVersionBody,
  productionSettingsBody,
  productionTags,
  productionVersionBody,
  providerTriggeredBy,
} from "./test/production-pool-worker-shape.ts";

// The class step's first run against production's settings read, through the real SDK and the real
// Effect fetch client. Cloudflare returns its own `workers/triggered_by` from the settings read,
// stamps it on every version it creates, and refused an upload that copied it.

const target = { accountId: "fixture-account", scriptName: "fixture-worker" };
const classes = ["PoolContainer", "PoolRuntime"];
const bindings = classes.map((name) => ({
  type: "durable_object_namespace",
  name,
  class_name: name,
  namespace_id: `namespace-${name}`,
}));
const entry = {
  action: "add-sqlite-class",
  type: "Cloudflare.Worker",
  fqn: "PoolWorker",
  newSqliteClasses: ["PoolRuntimeBlue", "PoolRuntimeGreen"],
  addedBindings: ["PoolRuntimeBlue", "PoolRuntimeGreen"].map((name) => ({
    type: "durable_object_namespace",
    name,
    className: name,
    location: "local",
  })),
  retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
} as unknown as SqliteClassDeclaration;
const marker = `basalt-declared:${"a".repeat(40)}:${"b".repeat(64)}`;
const baselineContent = {
  mainModule: "worker.js",
  files: [
    {
      name: "worker.js",
      type: "application/javascript+module",
      bytes: new TextEncoder().encode("export default {}"),
    },
  ],
};

type Clone = Record<string, unknown> & { annotations?: Record<string, string> };

async function stub(context: TestContext, settings: Record<string, unknown>) {
  const posts: Clone[] = [];
  const clones = new Map<string, ReturnType<typeof productionVersionBody>>();
  let latest: ReturnType<typeof productionVersionBody> | undefined;
  const read = (path: string) => {
    if (path.endsWith("/deployments")) return productionDeploymentsBody("active");
    // Production's /settings follows the latest upload, so a staged clone's annotations show there.
    if (path.endsWith("/settings"))
      return latest ? { ...settings, annotations: latest.annotations } : settings;
    if (path.endsWith("/workers/workers/fixture-worker/versions/active"))
      return productionVersionBody({
        id: "active",
        mainModule: "worker.js",
        modules: [],
        bindings,
        containers: ["PoolContainer"],
      });
    const clone = clones.get(path.split("/").at(-1)!);
    if (clone) return clone;
    if (path.endsWith("/workers/workers/fixture-worker"))
      return productionProfileBody("fixture-worker", "immutable-worker");
    if (path.endsWith("/scripts/fixture-worker/versions/active"))
      return productionScriptVersionBody({ id: "active", bindings, classes });
    return undefined;
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const path = (request.url ?? "").split("?")[0]!;
    const reply = (status: number, result: unknown, errors: unknown[] = []) => {
      response.setHeader("content-type", "application/json");
      response.statusCode = status;
      response.end(JSON.stringify({ success: status === 200, errors, messages: [], result }));
    };
    if (request.method === "POST" && path.endsWith("/workers/workers/fixture-worker/versions")) {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Clone;
      posts.push(body);
      if (body.annotations?.[providerTriggeredBy] !== undefined)
        return reply(400, null, [{ code: 10021, message: "workers/triggered_by is read-only" }]);
      const id = `clone-${posts.length}`;
      // Production's version read-back: its own key set (no placement), stamped by Cloudflare.
      latest = productionVersionBody({
        id,
        mainModule: String(body.main_module),
        modules: body.modules as Parameters<typeof productionVersionBody>[0]["modules"],
        bindings,
        containers: ((body.containers ?? []) as { class_name: string }[]).map((c) => c.class_name),
        annotations: { ...body.annotations, [providerTriggeredBy]: "version_upload" },
      });
      clones.set(id, latest);
      return reply(200, { id, number: 2, created_on: "2026-11-18T00:00:00Z", urls: [] });
    }
    const value = request.method === "GET" ? read(path) : undefined;
    return value ? reply(200, value) : reply(404, null, [{ code: 10071, message: "not found" }]);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const layer = Layer.mergeAll(
    FetchHttpClient.layer,
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "synthetic", apiBaseUrl: base })),
    ),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic" } })),
  );
  const settingsFetch: typeof fetch = (input, init) =>
    fetch(String(input).replace("https://api.cloudflare.com/client/v4", base), init);
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
  return {
    posts,
    read: () => run(readDeclaredClass(target, settingsFetch).pipe(Effect.provide(layer))),
    stage: (request: Parameters<typeof stageClassClone>[0]) =>
      run(stageClassClone(request).pipe(Effect.provide(layer))),
    readClone: (versionId: string) =>
      run(readClassClone(target, versionId).pipe(Effect.provide(layer))),
  };
}

const production = () => productionSettingsBody(bindings, productionTags(classes));

test("the class PUT keeps only caller-owned annotations and echoes production's other settings", async (context) => {
  // Copying the read's annotations wholesale fails the PUT's strict metadata decode.
  const cloudflare = await stub(context, production());
  const observed = await cloudflare.read();
  assert.equal(observed.settings.annotations?.workersTriggeredBy, "version_upload");
  const request = expansionRequest(
    observed,
    expansionContent(baselineContent, entry),
    entry,
    undefined,
    productionTags([...classes, ...entry.newSqliteClasses]),
    marker,
  );
  assert.deepEqual(request.metadata.annotations, { workersMessage: marker });
  // Production's settings read shows no placement as `{}`; the PUT sends none.
  assert.equal(request.metadata.placement, undefined);
  assert.deepEqual(request.metadata.tailConsumers, []);
  assert.equal(request.metadata.logpush, false);
  assert.deepEqual(request.metadata.observability, observed.settings.observability);
  assert.equal(request.metadata.compatibilityDate, observed.settings.compatibilityDate);
});

test("the clone POST carries no provider-managed annotation and accepts Cloudflare's own stamp on the read-back", async (context) => {
  const cloudflare = await stub(context, production());
  const observed = await cloudflare.read();
  const request = cloneRequest(observed, baselineContent, marker, entry.fqn);
  assert.deepEqual(request.annotations, { workersMessage: `${marker}:clone` });
  const { versionId } = await cloudflare.stage(request);
  const [sent] = cloudflare.posts;
  assert.deepEqual(sent?.annotations, { "workers/message": `${marker}:clone` });
  for (const key of ["logpush", "observability", "tail_consumers", "tags"])
    assert.equal(key in sent!, false, `${key} is script-level and stays out of a version`);
  const actual = await cloudflare.readClone(versionId);
  assert.equal(actual?.annotations?.workersTriggeredBy, "version_upload");
  assert.equal("placement" in sent!, false);
  const saved = { baseline: observed, clone: { request, versionId } } as unknown as ClassRecord;
  assertClone(entry.fqn, saved, actual);
  // The live baseline is unchanged although /settings now shows the clone's own annotations.
  const after = await cloudflare.read();
  assert.notEqual(canonical(after), canonical(observed));
  assert.equal(baselineKey(after), baselineKey(observed));
  // The comparison still holds the caller-owned keys: a foreign marker refuses.
  assert.throws(
    () =>
      assertClone(entry.fqn, saved, {
        ...actual!,
        annotations: { ...actual!.annotations, workersMessage: "foreign" },
      }),
    (error: unknown) =>
      error instanceof BarrierRefusal && error.reason === "declared-class-clone-mismatch",
  );
});

test("an annotation the rule does not know refuses with a named code, from the read or a decoded value", async (context) => {
  const cloudflare = await stub(context, {
    ...production(),
    annotations: { [providerTriggeredBy]: "version_upload", "workers/unknown_field": "x" },
  });
  await assert.rejects(
    cloudflare.read(),
    (error: unknown) =>
      error instanceof BarrierRefusal &&
      error.reason === "declared-class-baseline-settings-unsupported",
  );
  assert.throws(
    () => classAnnotations({ workersMessage: "m", workersFutureKey: "x" }, entry.fqn, "settings"),
    (error: unknown) =>
      error instanceof BarrierRefusal &&
      error.reason === "declared-class-annotation-unsupported" &&
      canonical(error.delta?.changed) ===
        canonical([
          {
            path: "settings.annotations",
            old: "caller-owned-or-provider-managed",
            new: "workers/future_key",
          },
        ]),
  );
  assert.deepEqual(
    classAnnotations({ workersTriggeredBy: "anything", workersTag: null }, entry.fqn, "settings"),
    {},
  );
});
