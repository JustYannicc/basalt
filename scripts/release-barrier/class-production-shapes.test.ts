import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { ConfigProvider, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import type * as HttpClient from "effect/http/HttpClient";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import {
  deleteClassClone,
  deployClassExpansion,
  readClassClone,
  readClassContent,
  readDeclaredClass,
  stageClassClone,
} from "./class-cloudflare.ts";
import {
  expansionContent,
  expansionRequest,
  contentDigest,
  payloadDigest,
} from "./class-payload.ts";
import { assertClone, cloneRequest } from "./class-clone.ts";
import { assertClassObservation } from "./class-observation.ts";
import { State, type StateService } from "alchemy/State/State";
import { classHistory, saveClassHistory, type ClassRecord } from "./class-history.ts";
import { restoreClassRecord } from "./class-recovery.ts";
import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import { canonical, digest } from "./manifest.ts";

// The class step's Cloudflare calls against production's real response shapes (key sets and
// sizes only; every value is synthetic). Real SDK + real FetchHttpClient + real fetch against a
// local HTTP server.

const account = "fixture-account";
const script = "fixture-worker";
const target = { accountId: account, scriptName: script };
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

// Production's ten settings keys, one binding per real kind.
const bindings = [
  { name: "POOL_PRESERVE_LEGACY_IMAGE", text: "true", type: "plain_text" },
  {
    class_name: "ArtifactsTokenCoordinator",
    name: "BulkUsageImport",
    namespace_id: "namespace-cross",
    script_name: "other-worker",
    type: "durable_object_namespace",
  },
  { name: "POOL_MANAGEMENT_KEY", type: "secret_text" },
  { id: "hyperdrive-id", name: "POOL_DATABASE", type: "hyperdrive" },
  {
    class_name: "PoolContainer",
    name: "PoolContainer",
    namespace_id: "namespace-local",
    type: "durable_object_namespace",
  },
  {
    name: "STORE_SECRET",
    secret_name: "secret",
    store_id: "store-id",
    type: "secrets_store_secret",
  },
  { environment: "production", name: "API", service: "api-worker", type: "service" },
];
const observability = {
  enabled: true,
  head_sampling_rate: 1,
  redact_query_string: true,
  logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
  traces: { enabled: false, persist: true, head_sampling_rate: 1 },
};
const liveTags = [
  "alchemy:stack:basalt",
  "alchemy:stage:production",
  "alchemy:id:PoolWorker",
  "alchemy:dos:PoolContainer=PoolContainer",
];
const plannedTags = [
  ...liveTags.slice(0, 3),
  "alchemy:dos:PoolContainer=PoolContainer;PoolRuntimeBlue=PoolRuntimeBlue;PoolRuntimeGreen=PoolRuntimeGreen",
];
const flags = ["nodejs_compat", "new_module_registry"];
const entrySource =
  "class PoolContainer{}class PoolRuntime{}class PoolRuntimeBlue{}class PoolRuntimeGreen{}var e_={};" +
  "export{PoolContainer,PoolRuntime,PoolRuntimeBlue,PoolRuntimeGreen,e_ as default};";

interface Version {
  id: string;
  number: number;
  bindings: unknown[];
  annotations: Record<string, string>;
  /** content/v2 parts; only non-map parts appear in `modules`. */
  parts: { name: string; type: string; bytes: Uint8Array }[];
  containers: string[];
}

function world() {
  const versions = new Map<string, Version>();
  const serving: Version = {
    id: "serving-version",
    number: 240,
    bindings,
    annotations: { "workers/triggered_by": "version_upload" },
    parts: [
      {
        name: "worker.js",
        type: "application/javascript+module",
        bytes: new TextEncoder().encode(entrySource),
      },
      {
        name: "worker.js.map",
        type: "application/source-map",
        bytes: new TextEncoder().encode("{}"),
      },
    ],
    containers: ["PoolContainer"],
  };
  versions.set(serving.id, serving);
  const state = { active: serving.id, latest: serving.id, tags: [...liveTags], serial: 241 };
  const log: { method: string; path: string; query: string; body?: unknown; bytes: number }[] = [];
  const settings = () => {
    const version = versions.get(state.latest)!;
    return {
      placement: {},
      compatibility_date: "2026-09-08",
      compatibility_flags: flags,
      usage_model: "standard",
      tags: state.tags,
      tail_consumers: [],
      logpush: false,
      observability,
      annotations: version.annotations,
      bindings: version.bindings,
    };
  };
  // The Workers API version read; `modules` only with include=modules, never the map.
  const beta = (version: Version, modules: boolean) => ({
    id: version.id,
    number: version.number,
    startup_time_ms: 252,
    compatibility_date: "2026-09-08",
    compatibility_flags: flags,
    main_module: "worker.js",
    annotations: version.annotations,
    usage_model: "standard",
    containers: version.containers.map((class_name) => ({ class_name })),
    urls: [],
    source: "api",
    created_on: "2026-11-18T07:57:13.000000Z",
    ...(modules
      ? {
          modules: version.parts
            .filter((part) => part.type !== "application/source-map")
            .map((part) => ({
              name: part.name,
              content_type: part.type,
              content_base64: Buffer.from(part.bytes).toString("base64"),
            })),
        }
      : {}),
    bindings: version.bindings,
    env: Object.fromEntries(
      (version.bindings as { name: string }[]).map(({ name, ...rest }) => [name, rest]),
    ),
    author_id: "author",
    author_email: "author@example.invalid",
  });
  return { versions, state, log, settings, beta, serving };
}

async function serve(context: TestContext, w: ReturnType<typeof world>) {
  const base = `/accounts/${account}/workers`;
  const ok = (result: unknown, info?: unknown) => ({
    status: 200,
    json: {
      result,
      success: true,
      errors: [],
      messages: [],
      ...(info ? { result_info: info } : {}),
    },
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(request.url ?? "", "http://stub");
    const path = url.pathname;
    const type = String(request.headers["content-type"] ?? "");
    let body: unknown;
    let form: FormData | undefined;
    if (raw.length && type.startsWith("multipart/form-data")) {
      form = await new Response(raw, { headers: { "content-type": type } }).formData();
      const part = form.get("metadata");
      body = JSON.parse(typeof part === "string" ? part : await (part as Blob).text());
    } else if (raw.length) body = JSON.parse(raw.toString("utf8"));
    w.log.push({ method: request.method!, path, query: url.search, body, bytes: raw.length });
    const send = (value: { status: number; json: unknown }) => {
      response.statusCode = value.status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value.json));
    };
    const missing = () =>
      send({
        status: 404,
        json: {
          result: null,
          success: false,
          errors: [{ code: 10071, message: "not found" }],
          messages: [],
        },
      });
    if (request.method === "GET") {
      if (path === `${base}/scripts/${script}/deployments`)
        return send(
          ok(
            {
              deployments: [
                {
                  id: "deployment",
                  source: "api",
                  strategy: "percentage",
                  author_email: "author@example.invalid",
                  annotations: { "workers/triggered_by": "deployment" },
                  versions: [{ version_id: w.state.active, percentage: 100 }],
                  created_on: "2026-11-18T07:59:50.000000Z",
                },
              ],
            },
            { page: 1, per_page: 10, count: 10, total_count: 231, total_pages: 24 },
          ),
        );
      if (path === `${base}/scripts/${script}/settings`) return send(ok(w.settings()));
      if (path === `${base}/workers/${script}`)
        return send(
          ok({
            id: "immutable-worker",
            name: script,
            tags: w.state.tags,
            observability,
            logpush: false,
            created_on: "2026-11-01T00:00:00.000000Z",
            updated_on: "2026-11-18T07:59:50.000000Z",
            deployed_on: "2026-11-18T07:59:50.000000Z",
            references: {
              workers: [{ id: "other", name: "other-worker" }],
              domains: [],
              dispatch_namespace_outbounds: [],
              durable_objects: [
                {
                  worker_id: "other",
                  worker_name: "other-worker",
                  namespace_id: "n",
                  namespace_name: "x",
                },
              ],
              queues: [],
            },
            subdomain: {
              enabled: false,
              previews_enabled: false,
              url: "fixture.example.invalid",
              preview_url_suffix: "fixture.example.invalid",
            },
            tail_consumers: [],
          }),
        );
      const classic = new RegExp(`^${base}/scripts/${script}/versions/([^/]+)$`, "u").exec(path);
      if (classic) {
        const version = w.versions.get(classic[1]!);
        if (!version) return missing();
        return send(
          ok({
            id: version.id,
            number: version.number,
            metadata: {
              created_on: "2026-11-18T07:57:13.000000Z",
              source: "api",
              author_id: "author",
              author_email: "author@example.invalid",
              has_preview: false,
            },
            annotations: version.annotations,
            resources: {
              script: {
                etag: "etag",
                handlers: ["fetch", "scheduled"],
                named_handlers: [
                  { name: "PoolContainer", handlers: ["class"] },
                  { name: "PoolRuntime", handlers: ["class"] },
                  { name: "PoolRuntimeBlue", handlers: ["class"] },
                  { name: "PoolRuntimeGreen", handlers: ["class"] },
                  { name: "PoolHomePeer", handlers: ["fetch"] },
                ],
                last_deployed_from: "api",
              },
              script_runtime: {
                compatibility_date: "2026-09-08",
                compatibility_flags: flags,
                usage_model: "standard",
                containers: version.containers.map((class_name) => ({ class_name })),
              },
              bindings: version.bindings,
            },
          }),
        );
      }
      const version = new RegExp(`^${base}/workers/${script}/versions/([^/]+)$`, "u").exec(path);
      if (version) {
        const found = w.versions.get(version[1] === "latest" ? w.state.latest : version[1]!);
        if (!found) return missing();
        return send(ok(w.beta(found, url.searchParams.get("include") === "modules")));
      }
      if (path === `${base}/scripts/${script}/content/v2`) {
        const found = w.versions.get(url.searchParams.get("version") ?? "");
        if (!found) return missing();
        const out = new FormData();
        for (const part of found.parts)
          out.set(
            part.name,
            new File([new Uint8Array(part.bytes)], part.name, { type: part.type }),
          );
        const web = new Response(out);
        response.statusCode = 200;
        response.setHeader("content-type", web.headers.get("content-type")!);
        response.setHeader("cf-entrypoint", "worker.js");
        return response.end(Buffer.from(await web.arrayBuffer()));
      }
      return missing();
    }
    if (request.method === "PUT" && path === `${base}/scripts/${script}`) {
      const metadata = body as {
        bindings: { type: string; name: string; class_name?: string }[];
        tags: string[];
        annotations?: Record<string, string>;
        containers?: { class_name: string }[];
      };
      const previous = w.versions.get(w.state.latest)!;
      const next: Version = {
        id: "expansion-version",
        number: ++w.state.serial,
        bindings: metadata.bindings.map((binding) =>
          binding.type === "inherit"
            ? (previous.bindings as { name: string }[]).find((item) => item.name === binding.name)!
            : { ...binding, namespace_id: `namespace-${binding.class_name}` },
        ),
        annotations: { ...metadata.annotations, "workers/triggered_by": "upload" },
        parts: await Promise.all(
          [...form!.entries()]
            .filter(([name]) => name !== "metadata")
            .map(async ([, file]) => ({
              name: (file as File).name,
              type: (file as File).type,
              bytes: new Uint8Array(await (file as File).arrayBuffer()),
            })),
        ),
        containers: (metadata.containers ?? []).map((container) => container.class_name),
      };
      w.versions.set(next.id, next);
      w.state.active = next.id;
      w.state.latest = next.id;
      w.state.tags = metadata.tags;
      // The script upload response: no migration_tag on an untagged Worker.
      return send(
        ok({
          id: script,
          tag: "etag",
          etag: "etag",
          handlers: ["fetch", "scheduled"],
          named_handlers: [{ name: "PoolContainer", handlers: ["class"] }],
          modified_on: "2026-11-18T19:30:00.000000Z",
          created_on: "2026-11-01T00:00:00.000000Z",
          usage_model: "standard",
          compatibility_date: "2026-09-08",
          compatibility_flags: flags,
          has_assets: false,
          has_modules: true,
          logpush: false,
          tail_consumers: [],
          placement: {},
          observability,
          last_deployed_from: "api",
          startup_time_ms: 252,
          deployment_id: "deployment-2",
        }),
      );
    }
    if (request.method === "POST" && path === `${base}/workers/${script}/versions`) {
      const posted = body as {
        modules: { name: string; content_type: string; content_base64: string }[];
        bindings: { name: string; version_id: string }[];
        annotations?: Record<string, string>;
        containers?: { class_name: string }[];
      };
      const source = w.versions.get(posted.bindings[0]!.version_id)!;
      const next: Version = {
        id: "clone-version",
        number: ++w.state.serial,
        bindings: source.bindings,
        annotations: { ...posted.annotations, "workers/triggered_by": "create_version_api" },
        parts: posted.modules.map((module) => ({
          name: module.name,
          type: module.content_type,
          bytes: new Uint8Array(Buffer.from(module.content_base64, "base64")),
        })),
        containers: (posted.containers ?? []).map((container) => container.class_name),
      };
      w.versions.set(next.id, next);
      w.state.latest = next.id;
      return send(ok(w.beta(next, false)));
    }
    const removed = new RegExp(`^${base}/workers/${script}/versions/([^/]+)$`, "u").exec(path);
    if (request.method === "DELETE" && removed && w.versions.delete(removed[1]!))
      return send(ok(null));
    return missing();
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
  return `http://127.0.0.1:${address.port}`;
}

const run = <A, E>(
  base: string,
  effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(
        Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken: "synthetic", apiBaseUrl: base })),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic" } }),
        ),
      ),
    ),
  );
const refusal = (fn: () => void) => {
  try {
    fn();
    return undefined;
  } catch (error) {
    const value = error as {
      reason?: string;
      message?: string;
      refusals?: unknown;
      changed?: unknown;
    };
    return JSON.stringify(
      { reason: value.reason ?? value.message, detail: value.refusals ?? value.changed ?? value },
      null,
      0,
    ).slice(0, 1800);
  }
};

test("the class step against production's real response shapes, end to end", async (context) => {
  const w = world();
  const base = await serve(context, w);
  const local: typeof fetch = (input, init) =>
    fetch(String(input).replace("https://api.cloudflare.com/client/v4", base), init);
  const report: Record<string, unknown> = {};

  // class-preparation.ts:114, :220
  const observed = await run(base, readDeclaredClass(target, local));
  const baseline = await run(base, readClassContent(observed, observed.versionId, local));
  report.contentParts = baseline.files.map((file) => `${file.name} (${file.type})`);

  // class-preparation.ts:223-233
  const content = expansionContent(baseline, entry);
  const marker = `basalt-declared:${"a".repeat(40)}:${"b".repeat(64)}`;
  const request = expansionRequest(observed, content, entry, undefined, plannedTags, marker);
  const clone = cloneRequest(observed, baseline, marker, entry.fqn);
  const saved: ClassRecord = {
    entry: digest(canonical(entry)),
    declaration: "c".repeat(64),
    candidate: "a".repeat(40),
    native: { instanceId: "instance", workerId: observed.workerId, providerVersion: 0 },
    baseline: observed,
    marker,
    content: contentDigest(content),
    payload: payloadDigest(request, content),
    tags: [...(request.metadata.tags ?? [])],
    recovery: {
      metadata: request.metadata,
      mainModule: content.mainModule,
      files: content.files.map((file) => ({
        name: file.name,
        type: file.type,
        base64: Buffer.from(file.bytes).toString("base64"),
      })),
    },
    clone: { request: clone, payload: digest(canonical(clone)), status: "pending" },
    status: "clone-pending",
  };

  // class-clone.ts:195-201: POST, read back, compare.
  const staged = await run(base, stageClassClone(clone));
  const post = w.log.find((item) => item.method === "POST")!;
  report.clonePost = { query: post.query, keys: Object.keys(post.body as object).sort() };
  report.clonePostBinding = (post.body as { bindings: unknown[] }).bindings[0];
  report.clonePostAnnotations = (post.body as { annotations: unknown }).annotations;
  report.clonePostPlacement = (post.body as { placement?: unknown }).placement;
  report.clonePostModules = (post.body as { modules: { name: string }[] }).modules.map(
    (m) => m.name,
  );
  const readBack = await run(base, readClassClone(observed, staged.versionId));
  report.cloneReadBackModules = readBack?.modules?.map((module) => module.name);
  report.cloneMismatch = refusal(() =>
    assertClone(
      entry.fqn,
      { ...saved, clone: { ...saved.clone, versionId: staged.versionId } },
      readBack,
    ),
  );

  // class-clone.ts:211-219: the baseline re-read after staging must equal the frozen baseline.
  // This stub models /settings following the LATEST upload, i.e. the clone.
  const reread = await run(base, readDeclaredClass(observed, local));
  report.baselineRereadAfterClone =
    canonical(reread) === canonical(observed)
      ? "equal"
      : { annotations: reread.settings.annotations, was: observed.settings.annotations };

  // declared-classes.ts:74-98: PUT, read back, attribute.
  const result = await run(base, deployClassExpansion(request));
  const put = w.log.find((item) => item.method === "PUT")!;
  const metadata = put.body as Record<string, unknown>;
  report.put = { query: put.query, keys: Object.keys(metadata).sort(), bytes: put.bytes };
  report.putMigrations = metadata.migrations;
  report.putPlacement = metadata.placement;
  report.putObservability = metadata.observability;
  report.putTailConsumers = metadata.tail_consumers;
  report.putLogpush = metadata.logpush;
  report.putAnnotations = metadata.annotations;
  report.putBindings = (metadata.bindings as { type: string }[]).map((binding) => binding.type);
  report.putResult = result;
  const after = await run(base, readDeclaredClass(observed, local));
  report.expansionMismatch = refusal(() => assertClassObservation(entry, saved, after, true));
  const afterContent = await run(base, readClassContent(after, after.versionId, local));
  report.expansionContentMatches = contentDigest(afterContent) === saved.content;

  // State keeps digests only. A rerun after the PUT (the active version is now the expansion) gets
  // the bytes back from the frozen baseline version's content read, and the digests verify them.
  let output: unknown;
  const state = {
    getOutput: () => Effect.succeed(output),
    setOutput: (input: { value: unknown }) =>
      Effect.sync(() => {
        output = JSON.parse(JSON.stringify(input.value));
        return input.value;
      }),
  } as unknown as StateService;
  await Effect.runPromise(
    saveClassHistory({ stack: "basalt", stage: "production" }, entry.fqn, saved).pipe(
      Effect.provideService(State, Effect.succeed(state)),
    ),
  );
  const stored = classHistory(output)[entry.fqn]!;
  report.storedModuleBytes = [
    ...stored.recovery.files.map((file) => file.base64),
    ...(stored.clone.request.modules ?? []).map((module) => module.contentBase64),
  ].join("").length;
  const frozen = await run(
    base,
    readClassContent(stored.baseline, stored.baseline.versionId, local),
  );
  const restored = restoreClassRecord(stored, frozen, entry, entry.fqn);
  report.restoredMatches =
    canonical(restored.recovery) === canonical(saved.recovery) &&
    canonical(restored.clone.request) === canonical(saved.clone.request);

  // class-readiness.ts:46 on the second pass, and the record's strict decode after a state round trip.
  const ready: ClassRecord = { ...saved, status: "ready", observed: after, startupTimeMs: 252 };
  const second = await run(base, readDeclaredClass(ready.baseline, local));
  report.readinessMismatch = refusal(() => assertClassObservation(entry, ready, second));
  report.historyDecode = refusal(() => {
    const stored = JSON.parse(JSON.stringify({ $basaltDeclaredClasses: { PoolWorker: ready } }));
    classHistory(stored);
  });

  // class-clone.ts:246-262: delete the clone and confirm absence.
  await run(base, deleteClassClone(observed, staged.versionId));
  report.cloneGone = (await run(base, readClassClone(observed, staged.versionId))) === undefined;
  report.getWithBody = w.log.filter((item) => item.method === "GET" && item.bytes > 0).length;

  console.log(`REPORT ${JSON.stringify(report, null, 1)}`);
  assert.equal(report.getWithBody, 0);
  assert.deepEqual(report.putMigrations, {
    new_sqlite_classes: ["PoolRuntimeBlue", "PoolRuntimeGreen"],
  });
  assert.equal(report.expansionMismatch, undefined, "expansion read-back must match");
  assert.equal(report.expansionContentMatches, true);
  assert.equal(report.storedModuleBytes, 0, "no module bytes reach State");
  assert.equal(report.restoredMatches, true, "a rerun restores the exact request bytes");
  assert.equal(report.historyDecode, undefined);
  assert.equal(report.cloneGone, true);
});
