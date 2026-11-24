import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Exit } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as KV from "@distilled.cloud/cloudflare/kv";
import * as Queues from "@distilled.cloud/cloudflare/queues";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as Vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Workflows from "@distilled.cloud/cloudflare/workflows";
import { install, selfTest, WireRefused, type WireGuardConfig } from "./wire-guard.ts";
import { bindingShapes } from "./fixed-bindings.ts";
import {
  ACCOUNT,
  MAIN,
  MAIN_SOURCE,
  POOL_WORKER,
  applicationBody,
  applicationRead,
  credentials,
  poolWorkerUpload,
  startServer,
  type ServerOptions,
} from "./test/wire-guard-fixture.ts";
import { makePlan, productionRows } from "./test/plan-fixture.ts";

const CUTOVER = ["PoolRuntimeBlue", "PoolRuntimeGreen"];

/** The innermost cause of a failed shadow reconcile, for the assertion message. */
const describe = (error: unknown): string => {
  const parts: string[] = [];
  for (let at = error, depth = 0; at && depth < 8; depth++) {
    parts.push(String(at));
    at = (at as { cause?: unknown }).cause;
  }
  return parts.join(" <- ");
};

/** Runs `run` through the real FetchHttpClient and real fetch with the guard installed. */
const guarded = async <A, E>(
  context: TestContext,
  config: WireGuardConfig,
  run: (base: string) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  options: ServerOptions = {},
) => {
  const server = await startServer(options);
  context.after(server.close);
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install(config);
        const exit = yield* Effect.exit(
          run(server.base).pipe(
            Retry.none,
            credentials(server.base),
            Effect.provide(FetchHttpClient.layer),
            Effect.provide(guard.layer),
          ),
        );
        const refused = yield* Effect.exit(Effect.timeout(guard.refused, "10 millis"));
        return { exit, refused, journal: [...guard.journal] };
      }),
    ),
  );
  return { ...result, received: server.received, base: server.base };
};

/** The WireRefused under distilled's and FetchHttpClient's wrappers. */
const refusalOf = (exit: Exit.Exit<unknown, unknown>): WireRefused => {
  assert.ok(Exit.isFailure(exit), "expected the request to be refused");
  let error: unknown = Cause.squash(exit.cause);
  for (let depth = 0; depth < 8 && !(error instanceof WireRefused); depth++) {
    const next = error as { cause?: unknown; reason?: unknown; error?: unknown } | undefined;
    error = next?.reason ?? next?.cause ?? next?.error;
  }
  assert.ok(
    error instanceof WireRefused,
    `no wire guard refusal in ${String(Cause.squash(exit.cause))}`,
  );
  return error;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const deletions: ReadonlyArray<[string, Workers.PutScriptRequest["metadata"]["migrations"]]> = [
  ["single step", { deletedClasses: ["PoolContainer"] }],
  ["tagged steps", { oldTag: "v1", newTag: "v2", steps: [{ deletedClasses: ["PoolContainer"] }] }],
];
for (const [shape, migrations] of deletions)
  test(`a ${shape} upload deleting PoolContainer is refused before a byte leaves`, async (t) => {
    const run = await guarded(t, {}, () => Workers.putScript(poolWorkerUpload(migrations)));
    const refused = refusalOf(run.exit);
    assert.match(refused.field, /^migrations(\.steps\[0\])?\.deleted_classes$/);
    assert.equal(refused.value, '["PoolContainer"]');
    assert.equal(refused.resource, `Worker ${POOL_WORKER}`);
    assert.equal(refused.method, "PUT");
    assert.ok(refused.why && refused.fix);
    assert.deepEqual(run.received, []);
    assert.ok(Exit.isFailure(run.refused), "guard.refused reports the refusal");
    // The journal names the route only: no account, script name or body.
    const port = new URL(run.base).host;
    assert.deepEqual(run.journal, [
      { method: "PUT", host: port, path: "/accounts/{id}/workers/scripts/{id}" },
    ]);
    assert.ok(!JSON.stringify(run.journal).includes(ACCOUNT));
  });

test("a new SQLite class outside the allow-list is refused", async (t) => {
  const run = await guarded(t, {}, () =>
    Workers.putScript(poolWorkerUpload({ newSqliteClasses: ["X"] })),
  );
  const refused = refusalOf(run.exit);
  assert.equal(refused.field, "migrations.new_sqlite_classes");
  assert.equal(refused.value, '["X"]');
  assert.deepEqual(run.received, []);
});

const pinned = { [POOL_WORKER]: sha256(MAIN_SOURCE) };

test("the cutover migration is delivered when PoolWorker's allow-list names both classes", async (t) => {
  const run = await guarded(
    t,
    { sqliteClasses: { [POOL_WORKER]: CUTOVER }, mainModuleSha256: pinned },
    () => Workers.putScript(poolWorkerUpload({ newSqliteClasses: CUTOVER })),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  assert.equal(run.received.length, 1);
  assert.equal(run.received[0]!.method, "PUT");
  assert.deepEqual((run.received[0]!.metadata as { migrations: unknown }).migrations, {
    new_sqlite_classes: CUTOVER,
  });
});

test("a Worker released as code only uploads its serving bindings and no migration", async (t) => {
  // The serving version as Cloudflare reads it back: namespace ids, values and secrets differ.
  const served = bindingShapes(
    [
      { type: "plain_text", name: "POOL_MODE", text: "served" },
      {
        type: "durable_object_namespace",
        name: "POOL_CONTAINER",
        class_name: "PoolContainer",
        namespace_id: "ns-1",
      },
      {
        type: "durable_object_namespace",
        name: "POOL_RUNTIME_BLUE",
        class_name: "PoolRuntimeBlue",
        namespace_id: "ns-2",
      },
      {
        type: "durable_object_namespace",
        name: "POOL_RUNTIME_GREEN",
        class_name: "PoolRuntimeGreen",
        namespace_id: "ns-3",
      },
      {
        type: "durable_object_namespace",
        name: "BulkUsageImport",
        class_name: "ArtifactsTokenCoordinator",
        script_name: "synthetic-other-worker",
        namespace_id: "ns-4",
      },
      { type: "secret_text", name: "POOL_SECRET" },
    ],
    POOL_WORKER,
  );
  const fixed = { fixedBindings: { [POOL_WORKER]: served } };
  const same = await guarded(t, fixed, () => Workers.putScript(poolWorkerUpload()));
  assert.ok(
    Exit.isSuccess(same.exit),
    String(Exit.isFailure(same.exit) && Cause.squash(same.exit.cause)),
  );
  const upload = poolWorkerUpload();
  const withBindings = (bindings: typeof upload.metadata.bindings) =>
    Workers.putScript({ ...upload, metadata: { ...upload.metadata, bindings } });
  const all = upload.metadata.bindings ?? [];
  for (const [change, bindings, named] of [
    ["drops a binding", all.filter((binding) => binding.name !== "POOL_SECRET"), "POOL_SECRET"],
    [
      "moves a class",
      all.map((binding) =>
        binding.name === "POOL_RUNTIME_BLUE"
          ? { ...binding, className: "PoolRuntimeNext" }
          : binding,
      ),
      "POOL_RUNTIME_BLUE",
    ],
    [
      "adds a binding",
      [...all, { type: "plain_text" as const, name: "EXTRA", text: "synthetic" }],
      "EXTRA",
    ],
  ] as const) {
    const run = await guarded(t, fixed, () => withBindings([...bindings]));
    const refused = refusalOf(run.exit);
    assert.equal(refused.field, "bindings", change);
    // Names only: no value, class or script name in the refusal.
    assert.equal(refused.value, named, change);
    assert.deepEqual(run.received, [], change);
  }
  // A migration refuses even where the script's allow-list and pinned code would admit it.
  const migrating = await guarded(
    t,
    { ...fixed, sqliteClasses: { [POOL_WORKER]: CUTOVER }, mainModuleSha256: pinned },
    () => Workers.putScript(poolWorkerUpload({ newSqliteClasses: CUTOVER })),
  );
  assert.equal(refusalOf(migrating.exit).field, "migrations.new_sqlite_classes");
  assert.deepEqual(migrating.received, []);
});

test("an allow-listed new SQLite class is refused unless the script's live code is pinned", async (t) => {
  const run = await guarded(t, { sqliteClasses: { [POOL_WORKER]: CUTOVER } }, () =>
    Workers.putScript(poolWorkerUpload({ newSqliteClasses: CUTOVER })),
  );
  const refused = refusalOf(run.exit);
  assert.deepEqual([refused.field, refused.value], ["main_module sha256", "not configured"]);
  assert.match(refused.why, /serving code byte for byte/u);
  assert.deepEqual(run.received, []);
  // A digest for another script does not pin this one.
  const other = await guarded(
    t,
    { sqliteClasses: { [POOL_WORKER]: CUTOVER }, mainModuleSha256: { "another-worker": "0" } },
    () => Workers.putScript(poolWorkerUpload({ newSqliteClasses: CUTOVER })),
  );
  assert.equal(refusalOf(other.exit).value, "not configured");
  assert.deepEqual(other.received, []);
});

const classChanges: ReadonlyArray<
  [string, Workers.PutScriptRequest["metadata"]["migrations"], string]
> = [
  ["a new non-SQLite class", { newClasses: ["PoolLedger"] }, '["PoolLedger"]'],
  [
    "a renamed class",
    { renamedClasses: [{ from: "PoolContainer", to: "PoolRoot" }] },
    '[{"from":"PoolContainer","to":"PoolRoot"}]',
  ],
  [
    "a transferred class",
    {
      transferredClasses: [
        { from: "PoolContainer", fromScript: "synthetic-other-worker", to: "PoolContainer" },
      ],
    },
    '[{"from":"PoolContainer","from_script":"synthetic-other-worker","to":"PoolContainer"}]',
  ],
];
for (const [label, migrations, value] of classChanges)
  test(`an upload with ${label} is refused, even on a disposable stage`, async (t) => {
    for (const config of [{}, { anyNewSqliteClass: true }]) {
      const run = await guarded(t, config, () => Workers.putScript(poolWorkerUpload(migrations)));
      const refused = refusalOf(run.exit);
      assert.match(refused.field, /^migrations\.(new|renamed|transferred)_classes$/u);
      assert.equal(refused.value, value);
      assert.deepEqual(run.received, []);
    }
  });

test("an upload whose main module is missing is refused when its digest is pinned", async (t) => {
  const upload = poolWorkerUpload();
  const run = await guarded(t, { mainModuleSha256: pinned }, () =>
    Workers.putScript({ ...upload, metadata: { ...upload.metadata, mainModule: "other.js" } }),
  );
  const refused = refusalOf(run.exit);
  assert.deepEqual([refused.field, refused.value], ["main_module", "other.js"]);
  assert.deepEqual(run.received, []);
});

test("the cutover upload Alchemy's own Worker provider builds is admitted", async (t) => {
  // A shadow reconcile: the real WorkerProvider reads PoolWorker's recorded production settings,
  // computes the migration and prepares its upload; the hook sends that exact request (what the
  // provider's own putScript would send) through the real client and the guard.
  const server = await startServer();
  t.after(server.close);
  const script = "basalt-production-poolworker";
  const config = {
    sqliteClasses: { [script]: CUTOVER },
    mainModuleSha256: {} as Record<string, string>,
  };
  const rows = productionRows();
  const worker = rows.PoolWorker as { bindings: { sid: string }[] };
  worker.bindings = worker.bindings.filter((binding) => binding.sid !== "PoolLedger");
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install(config);
        const planned = yield* Effect.exit(
          Effect.tryPromise(() =>
            makePlan(t, {
              rows,
              declared: { ledger: undefined, fleetClasses: true },
              settle: ["PoolWorker"],
              settleOnly: ["PoolWorker"],
              shadow: true,
              capture: (upload) =>
                Effect.gen(function* () {
                  const main = [upload.request.files ?? []]
                    .flat()
                    .find(
                      (file): file is File =>
                        file instanceof File && file.name === upload.request.metadata.mainModule,
                    );
                  // The cutover pins the serving bytes; the shadow's serving bytes are this bundle.
                  if (main) {
                    const bytes = yield* Effect.promise(() => main.arrayBuffer());
                    config.mainModuleSha256[upload.request.scriptName] = createHash("sha256")
                      .update(new Uint8Array(bytes))
                      .digest("hex");
                  }
                  yield* Workers.putScript(upload.request).pipe(
                    Retry.none,
                    credentials(server.base),
                    Effect.provide(FetchHttpClient.layer),
                    Effect.provide(guard.layer),
                  );
                  return upload.proposed!;
                }),
            }),
          ),
        );
        const refused = yield* Effect.exit(Effect.timeout(guard.refused, "10 millis"));
        return { planned, refused };
      }),
    ),
  );
  assert.ok(
    Exit.isSuccess(outcome.planned),
    String(Exit.isFailure(outcome.planned) && describe(Cause.squash(outcome.planned.cause))),
  );
  assert.ok(Exit.isFailure(outcome.refused), "the guard refused nothing");
  assert.deepEqual(
    server.received.map((request) => `${request.method} ${request.path}`),
    [`PUT /accounts/${"0".repeat(32)}/workers/scripts/${script}`],
  );
  const migrations = (server.received[0]!.metadata as { migrations: Record<string, unknown> })
    .migrations;
  assert.deepEqual(migrations.new_sqlite_classes, CUTOVER);
  assert.equal(migrations.old_tag, undefined);
  assert.equal(migrations.new_tag, undefined);
  for (const key of ["deleted_classes", "renamed_classes", "transferred_classes", "new_classes"])
    assert.deepEqual(migrations[key] ?? [], [], key);
});

test("the cutover migration is refused without the allow-list", async (t) => {
  const run = await guarded(t, { sqliteClasses: { "another-worker": CUTOVER } }, () =>
    Workers.putScript(poolWorkerUpload({ newSqliteClasses: CUTOVER })),
  );
  assert.equal(refusalOf(run.exit).value, JSON.stringify(CUTOVER));
  assert.deepEqual(run.received, []);
});

test("an exports tombstone is refused", async (t) => {
  const run = await guarded(t, {}, () =>
    Workers.createBetaWorkerVersion({
      accountId: ACCOUNT,
      workerId: POOL_WORKER,
      mainModule: MAIN,
      modules: [
        {
          name: MAIN,
          contentType: "application/javascript+module",
          contentBase64: Buffer.from(MAIN_SOURCE).toString("base64"),
        },
      ],
      // distilled types `exports` as one entry; the API takes a map by class name, as sent here.
      exports: {
        PoolContainer: { type: "durable_object", state: "deleted" },
      } as unknown as Workers.CreateBetaWorkerVersionRequest["exports"],
    }),
  );
  const refused = refusalOf(run.exit);
  assert.equal(refused.field, "exports.PoolContainer.state");
  assert.equal(refused.value, "deleted");
  assert.deepEqual(run.received, []);
});

const scriptUrl = (base: string) => `${base}/accounts/${ACCOUNT}/workers/scripts/${POOL_WORKER}`;
const noMetadata = () => {
  const form = new FormData();
  form.append(MAIN, new Blob([MAIN_SOURCE]), MAIN);
  return form;
};
for (const [name, body, value] of [
  ["a text body", HttpClientRequest.bodyText("not json"), "unparsable"],
  ["multipart without metadata", HttpClientRequest.bodyFormData(noMetadata()), "unparsable"],
  [
    "metadata whose class list is not a list",
    HttpClientRequest.bodyText(
      JSON.stringify({ main_module: MAIN, migrations: { deleted_classes: "PoolContainer" } }),
      "application/json",
    ),
    "malformed",
  ],
] as const)
  test(`a script upload with ${name} is refused`, async (t) => {
    const run = await guarded(t, {}, (base) =>
      HttpClient.execute(body(HttpClientRequest.put(scriptUrl(base)))),
    );
    const refused = refusalOf(run.exit);
    assert.deepEqual([refused.field, refused.value], ["metadata", value]);
    assert.deepEqual(run.received, []);
  });

test("DELETE of Hyperdrive and every other protected resource is refused", async (t) => {
  const run = await guarded(t, {}, () =>
    Hyperdrive.deleteConfig({ accountId: ACCOUNT, hyperdriveId: "synthetic-hyperdrive" }),
  );
  assert.equal(refusalOf(run.exit).resource, "Hyperdrive config synthetic-hyperdrive");
  assert.deepEqual(run.received, []);
  for (const path of [
    `/accounts/${ACCOUNT}/workers/scripts/${POOL_WORKER}`,
    `/accounts/${ACCOUNT}/r2/buckets/synthetic-vault`,
    `/accounts/${ACCOUNT}/d1/database/synthetic-d1`,
    `/accounts/${ACCOUNT}/workers/durable_objects/namespaces/synthetic-namespace`,
    `/accounts/${ACCOUNT}/secrets_store/stores/synthetic-store/secrets/synthetic-secret`,
    "/v1/organizations/synthetic-org/databases/synthetic-db",
    "/v1/organizations/synthetic-org/databases/synthetic-db/branches/main",
    "/v1/organizations/synthetic-org/databases/synthetic-db/branches/main/roles/synthetic-role",
  ]) {
    const raw = await guarded(t, {}, (base) => HttpClient.del(`${base}${path}`));
    assert.equal(refusalOf(raw.exit).value, "DELETE", path);
    assert.deepEqual(raw.received, [], path);
  }
});

test("DELETE of every other data-holding API on the account is refused", async (t) => {
  const distilled: ReadonlyArray<
    [string, Effect.Effect<unknown, unknown, Credentials | HttpClient.HttpClient>]
  > = [
    [
      "KV namespace synthetic-kv",
      KV.deleteNamespace({ accountId: ACCOUNT, namespaceId: "synthetic-kv" }),
    ],
    [
      "KV namespace synthetic-kv",
      KV.bulkDeleteNamespaces({ accountId: ACCOUNT, namespaceId: "synthetic-kv", body: ["key"] }),
    ],
    [
      "Queue synthetic-queue",
      Queues.deleteQueue({ accountId: ACCOUNT, queueId: "synthetic-queue" }),
    ],
    [
      "Queue synthetic-queue",
      Queues.startPurge({
        accountId: ACCOUNT,
        queueId: "synthetic-queue",
        deleteMessagesPermanently: true,
      }),
    ],
    [
      "Vectorize index synthetic-index",
      Vectorize.deleteIndex({ accountId: ACCOUNT, indexName: "synthetic-index" }),
    ],
    [
      "Vectorize index synthetic-index",
      Vectorize.deleteByIdsIndex({ accountId: ACCOUNT, indexName: "synthetic-index", ids: ["v"] }),
    ],
    [
      "Workflow synthetic-workflow",
      Workflows.deleteWorkflow({ accountId: ACCOUNT, workflowName: "synthetic-workflow" }),
    ],
  ];
  for (const [resource, call] of distilled) {
    const run = await guarded(t, {}, () => call);
    assert.equal(refusalOf(run.exit).resource, resource);
    assert.deepEqual(run.received, [], resource);
  }
  // The Artifacts API the repo itself calls (scripts/ensure-artifacts.ts), and KV's raw key deletes.
  for (const [method, path] of [
    ["DELETE", `/accounts/${ACCOUNT}/artifacts/namespaces/synthetic-vault`],
    ["DELETE", `/accounts/${ACCOUNT}/artifacts/namespaces/synthetic-vault/repos/synthetic-repo`],
    ["DELETE", `/accounts/${ACCOUNT}/storage/kv/namespaces/synthetic-kv/bulk`],
    ["DELETE", `/accounts/${ACCOUNT}/storage/kv/namespaces/synthetic-kv/values/key`],
    ["DELETE", `/accounts/${ACCOUNT}/vectorize/indexes/synthetic-index`],
    ["POST", `/accounts/${ACCOUNT}/queues/synthetic-queue/messages/purge`],
  ] as const) {
    const raw = await guarded(t, {}, (base) =>
      HttpClient.execute(HttpClientRequest.make(method)(`${base}${path}`)),
    );
    assert.equal(refusalOf(raw.exit).value, method, path);
    assert.deepEqual(raw.received, [], path);
  }
  // Reads and writes that keep data are not deletes.
  const read = await guarded(t, {}, (base) =>
    HttpClient.get(`${base}/accounts/${ACCOUNT}/storage/kv/namespaces/synthetic-kv/values/key`),
  );
  assert.ok(Exit.isSuccess(read.exit));
  assert.equal(read.received.length, 1);
});

test("a deploy can never redeploy the State store or write a Secrets Store secret", async (t) => {
  // A bootstrap redeploys `alchemy-state-store` and writes its token secret (StateStore/State.ts:376-386).
  const upload = await guarded(t, {}, () =>
    Workers.putScript({ ...poolWorkerUpload(undefined), scriptName: "alchemy-state-store" }),
  );
  assert.equal(refusalOf(upload.exit).resource, "State store {id}");
  assert.deepEqual(upload.received, []);
  for (const [method, path] of [
    ["PUT", `/accounts/${ACCOUNT}/workers/scripts/alchemy-state-store/settings`],
    ["POST", `/accounts/${ACCOUNT}/secrets_store/stores/synthetic-store/secrets`],
    ["PATCH", `/accounts/${ACCOUNT}/secrets_store/stores/synthetic-store/secrets/synthetic-secret`],
  ] as const) {
    const raw = await guarded(t, {}, (base) =>
      HttpClient.execute(HttpClientRequest.make(method)(`${base}${path}`)),
    );
    assert.equal(refusalOf(raw.exit).field, "method", path);
    assert.deepEqual(raw.received, [], path);
  }
});

test("only a container application created in this process may be deleted", async (t) => {
  const run = await guarded(t, {}, () =>
    Effect.gen(function* () {
      const created = yield* Containers.createContainerApplication({
        accountId: ACCOUNT,
        name: "synthetic-runtime",
        maxInstances: 1,
        configuration: { image: applicationBody("x").configuration.image },
      } as Containers.CreateContainerApplicationRequest);
      yield* Containers.deleteContainerApplication({
        accountId: ACCOUNT,
        applicationId: created.id,
      });
      return yield* Effect.exit(
        Containers.deleteContainerApplication({
          accountId: ACCOUNT,
          applicationId: "legacy-root-app",
        }),
      );
    }),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  const refused = refusalOf(run.exit.value);
  assert.equal(refused.resource, "container application legacy-root-app");
  // Not created here, so only a read showing it unattached and idle could admit it: none answers.
  assert.deepEqual([refused.field, refused.value], ["application read", "failed"]);
  assert.deepEqual(
    run.received.map((request) => `${request.method} ${request.path}`),
    [
      `POST /accounts/${ACCOUNT}/containers/applications`,
      `DELETE /accounts/${ACCOUNT}/containers/applications/app-created-in-run`,
      `GET /accounts/${ACCOUNT}/containers/applications/legacy-root-app`,
    ],
  );
});

const deleteApplication = (applicationId: string) =>
  Containers.deleteContainerApplication({ accountId: ACCOUNT, applicationId });
const reads = (received: ReadonlyArray<{ method: string; path: string }>) =>
  received.map((request) => `${request.method} ${request.path}`);
const appPath = (id: string) => `/accounts/${ACCOUNT}/containers/applications/${id}`;

test("an attachment-less application with nothing running may be deleted on a rerun", async (t) => {
  // A killed apply left Alchemy's precreate: the application exists without its namespace.
  const run = await guarded(t, {}, () => deleteApplication("precreated-app"), {
    applications: { "precreated-app": { body: applicationRead({ attached: false, active: 0 }) } },
  });
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  assert.deepEqual(reads(run.received), [
    `GET ${appPath("precreated-app")}`,
    `DELETE ${appPath("precreated-app")}`,
  ]);
  // The read went around the guard with the delete's own credentials.
  assert.equal(run.received[0]!.authorization, "Bearer synthetic");
  assert.equal(run.received[0]!.authorization, run.received[1]!.authorization);
});

test("an attached, running, or unreadable application is never deleted", async (t) => {
  for (const [label, answer, field, value] of [
    // The legacy root as production answers: attached to its namespace, one instance active.
    [
      "the root",
      { body: applicationRead({ attached: true, active: 1 }) },
      "durable_objects",
      "attached",
    ],
    [
      "attached and idle",
      { body: applicationRead({ attached: true, active: 0 }) },
      "durable_objects",
      "attached",
    ],
    [
      "unattached with an active instance",
      { body: applicationRead({ attached: false, active: 1 }) },
      "health.instances",
      '{"active":1}',
    ],
    [
      "a failed read",
      { status: 500, body: { success: false, errors: [], messages: [] } },
      "application read",
      "failed",
    ],
    [
      "a read without health",
      { body: { success: true, result: { id: "x" }, errors: [], messages: [] } },
      "application read",
      "failed",
    ],
    [
      "a read that does not report active",
      { body: { success: true, result: { health: { instances: { stopped: 1 } } } } },
      "health.instances",
      "active not reported",
    ],
  ] as const) {
    const run = await guarded(t, {}, () => deleteApplication("legacy-root-app"), {
      applications: { "legacy-root-app": answer },
    });
    const refused = refusalOf(run.exit);
    assert.deepEqual([refused.field, refused.value], [field, value], label);
    assert.deepEqual(reads(run.received), [`GET ${appPath("legacy-root-app")}`], label);
  }
  // No recorded answer at all (404) refuses the same way.
  const missing = await guarded(t, {}, () => deleteApplication("legacy-root-app"));
  assert.equal(refusalOf(missing.exit).field, "application read");
  assert.ok(!reads(missing.received).some((line) => line.startsWith("DELETE")));
});

test("only an application create feeds the created set", async (t) => {
  // A Worker version upload answers with its own `result.id`; it must not unlock a delete.
  const run = await guarded(
    t,
    {},
    (base) =>
      Effect.gen(function* () {
        yield* HttpClient.execute(
          HttpClientRequest.post(
            `${base}/accounts/${ACCOUNT}/workers/scripts/${POOL_WORKER}/versions`,
          ).pipe(
            HttpClientRequest.bodyText(JSON.stringify({ main_module: MAIN }), "application/json"),
          ),
        );
        return yield* Effect.exit(deleteApplication("legacy-root-app"));
      }),
    { versionId: "legacy-root-app" },
  );
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(refusalOf(run.exit.value).field, "application read");
  assert.ok(!reads(run.received).some((line) => line.startsWith("DELETE")));
});

test("a main module whose sha256 differs from the reviewed build is refused, printing both", async (t) => {
  const reviewed = sha256("export default {}; // reviewed\n");
  const run = await guarded(t, { mainModuleSha256: { [POOL_WORKER]: reviewed } }, () =>
    Workers.putScript(poolWorkerUpload()),
  );
  const refused = refusalOf(run.exit);
  assert.equal(refused.field, "main_module sha256");
  assert.equal(refused.value, `${sha256(MAIN_SOURCE)} (expected ${reviewed})`);
  assert.deepEqual(run.received, []);
  const same = await guarded(t, { mainModuleSha256: { [POOL_WORKER]: sha256(MAIN_SOURCE) } }, () =>
    Workers.putScript(poolWorkerUpload()),
  );
  assert.ok(Exit.isSuccess(same.exit));
  assert.equal(same.received.length, 1);
});

const probeScript = fileURLToPath(new URL("./test/wire-guard-probe.ts", import.meta.url));
const runProbe = async (context: TestContext, mode: string) => {
  const server = await startServer();
  context.after(server.close);
  const { stdout } = await promisify(execFile)(process.execPath, [probeScript, mode, server.base]);
  return { outcome: JSON.parse(stdout) as { ok: boolean; tag?: string; route?: string }, server };
};

test("selfTest passes in a fresh deploy process with the guard installed, sending nothing", async (t) => {
  const { outcome, server } = await runProbe(t, "installed");
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(server.received, []);
});

test("selfTest fails when the guard is not installed", async (t) => {
  const { outcome, server } = await runProbe(t, "missing");
  assert.deepEqual(outcome, { ok: false, tag: "WireGuardSelfTestFailed", route: "context" });
  assert.deepEqual(
    server.received.map((request) => request.method),
    ["PUT"],
    "without the guard the probe reaches the server, which is what selfTest must catch",
  );
});

test("selfTest fails when FetchHttpClient read the global fetch before install", async (t) => {
  const { outcome } = await runProbe(t, "late");
  assert.deepEqual(outcome, { ok: false, tag: "WireGuardSelfTestFailed", route: "default" });
});

test("selfTest passes in this process and the local server receives nothing", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install();
        yield* selfTest(server.base).pipe(Effect.provide(guard.layer));
      }),
    ),
  );
  assert.ok(Exit.isSuccess(exit), String(Exit.isFailure(exit) && Cause.squash(exit.cause)));
  assert.deepEqual(server.received, []);
});

test("the self-test's own refused probe does not end the deploy it guards", async () => {
  const pending = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install({});
        yield* selfTest().pipe(Effect.provide(guard.layer));
        return yield* Effect.exit(Effect.timeout(guard.refused, "20 millis"));
      }),
    ),
  );
  assert.ok(Exit.isFailure(pending));
  assert.equal(Cause.squash(pending.cause) instanceof WireRefused, false);
});

test("a disposable stage may create any new SQLite class but still never delete one", async (t) => {
  const created = await guarded(t, { anyNewSqliteClass: true }, () =>
    Workers.putScript(poolWorkerUpload({ newSqliteClasses: ["X", "Y"] })),
  );
  assert.ok(Exit.isSuccess(created.exit));
  const deleted = await guarded(t, { anyNewSqliteClass: true }, () =>
    Workers.putScript(poolWorkerUpload({ deletedClasses: ["PoolContainer"] })),
  );
  assert.equal(refusalOf(deleted.exit).field, "migrations.deleted_classes");
});

// Alchemy's own store-token read in CI (StateStore/State.ts readSecretViaEdge via
// Cloudflare/EdgeSession.ts uploadScript), sent through the real Cloudflare client: parts
// wrangler-session-config, metadata and the probe module, exactly as the stage observed.
const storeTokenRead = (
  overrides: { bindings?: unknown[]; extra?: Record<string, unknown> } = {},
) =>
  Workers.createScriptEdgePreview({
    accountId: ACCOUNT,
    scriptName: "alchemy-state-store",
    cfPreviewUploadConfigToken: "synthetic-upload-token",
    wranglerSessionConfig: { workersDev: true, minimalMode: true },
    metadata: {
      compatibilityDate: "2025-01-01",
      bindings: (overrides.bindings ?? [
        {
          type: "secrets_store_secret",
          name: "SECRET",
          secretName: "AlchemyStateStoreToken",
          storeId: "synthetic-store",
        },
      ]) as never,
      mainModule: "worker.js",
      ...overrides.extra,
    } as never,
    files: [
      new File(["export default { fetch() { return new Response('') } }"], "worker.js", {
        type: "application/javascript+module",
      }),
    ],
  });

test("Alchemy's edge-preview read of the State store token is the one store write let through", async (t) => {
  const run = await guarded(t, {}, () => storeTokenRead());
  assert.equal(
    run.received.filter((entry) =>
      entry.path.endsWith("/workers/scripts/alchemy-state-store/edge-preview"),
    ).length,
    1,
    `received ${JSON.stringify(run.received)}`,
  );
});

test("any other shape of edge-preview upload to the State store is refused", async (t) => {
  for (const [label, overrides] of [
    [
      "a second binding",
      {
        bindings: [
          {
            type: "secrets_store_secret",
            name: "SECRET",
            secretName: "AlchemyStateStoreToken",
            storeId: "s",
          },
          { type: "plain_text", name: "X", text: "y" },
        ],
      },
    ],
    [
      "a different secret",
      {
        bindings: [
          {
            type: "secrets_store_secret",
            name: "SECRET",
            secretName: "SomethingElse",
            storeId: "s",
          },
        ],
      },
    ],
    ["a migration", { extra: { migrations: { deletedClasses: ["StateStore"] } } }],
  ] as const) {
    const run = await guarded(t, {}, () => storeTokenRead(overrides as never));
    assert.equal(refusalOf(run.exit).resource, "State store edge-preview", label);
    assert.deepEqual(run.received, [], label);
  }
});

test("every other write to the State store script is still refused", async (t) => {
  for (const [method, suffix] of [
    ["PUT", ""],
    ["PATCH", "/settings"],
    ["POST", "/versions"],
    ["POST", "/deployments"],
    ["PUT", "/content"],
    ["DELETE", ""],
  ] as const) {
    const path = `/accounts/${ACCOUNT}/workers/scripts/alchemy-state-store${suffix}`;
    const raw = await guarded(t, {}, (base) =>
      HttpClient.execute(HttpClientRequest.make(method)(`${base}${path}`)),
    );
    assert.ok(Exit.isFailure(raw.exit), `${method} ${path}`);
    assert.deepEqual(raw.received, [], `${method} ${path}`);
  }
});

test("the root application is never patched, rolled out or deleted; other applications are not held", async (t) => {
  // The two calls Alchemy's ContainerProvider makes when it finds the root's configuration changed.
  const root = "legacy-root-app";
  const configuration = applicationBody("x").configuration;
  const run = await guarded(t, { rootApplications: [root] }, () =>
    Effect.gen(function* () {
      const patch = yield* Effect.exit(
        Containers.updateContainerApplication({
          accountId: ACCOUNT,
          applicationId: root,
          maxInstances: 1,
          configuration,
        } as Containers.UpdateContainerApplicationRequest),
      );
      const rollout = yield* Effect.exit(
        Containers.createContainerApplicationRollout({
          accountId: ACCOUNT,
          applicationId: root,
          description: "Immediate update",
          strategy: "rolling",
          kind: "full_auto",
          stepPercentage: 100,
          targetConfiguration: configuration,
        } as Containers.CreateContainerApplicationRolloutRequest),
      );
      const removal = yield* Effect.exit(deleteApplication(root));
      yield* Effect.exit(
        Containers.updateContainerApplication({
          accountId: ACCOUNT,
          applicationId: "cell-app",
          maxInstances: 2,
        } as Containers.UpdateContainerApplicationRequest),
      );
      return { patch, rollout, removal };
    }),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  const { patch, rollout, removal } = run.exit.value;
  for (const [exit, method] of [
    [patch, "PATCH"],
    [rollout, "POST"],
    [removal, "DELETE"],
  ] as const) {
    const refused = refusalOf(exit);
    assert.equal(refused.resource, `container application ${root}`);
    assert.deepEqual([refused.field, refused.value], ["method", method]);
    assert.match(refused.why, /restarts the root/u);
  }
  // The refusal is signalled, so the entry's race ends the run at once.
  assert.equal(refusalOf(run.refused).resource, `container application ${root}`);
  // Nothing reached the root, not even the read a delete of an unknown application makes.
  assert.deepEqual(reads(run.received), [`PATCH ${appPath("cell-app")}`]);
});

test("a destroy deletes exactly the resources its own plan names, and nothing else", async (t) => {
  const own = "basalt-test-pr-7-poolworker";
  const run = await guarded(t, { deletable: [{ kind: "Worker", id: own }] }, (base) =>
    Effect.gen(function* () {
      const mine = yield* Effect.exit(
        Workers.deleteScript({ accountId: ACCOUNT, scriptName: own }),
      );
      const other = yield* Effect.exit(
        Workers.deleteScript({ accountId: ACCOUNT, scriptName: "basalt-production-poolworker" }),
      );
      // The same name as another kind of resource is not a target.
      const bucket = yield* Effect.exit(
        Effect.tryPromise(() =>
          fetch(`${base}/accounts/${ACCOUNT}/r2/buckets/${own}`, { method: "DELETE" }),
        ),
      );
      return { own: mine, other, bucket };
    }),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  const refused = refusalOf(run.exit.value.other);
  assert.equal(refused.resource, "Worker basalt-production-poolworker");
  assert.equal(refusalOf(run.exit.value.bucket).resource, `R2 bucket ${own}`);
  assert.deepEqual(reads(run.received), [
    `DELETE /accounts/${ACCOUNT}/workers/scripts/basalt-test-pr-7-poolworker`,
  ]);
});

test("a destroy plan's Workflow row admits that Workflow's delete and no other", async (t) => {
  const { destroyTargets } = await import("./plan-summary.ts");
  const own = "basalt-rehearsal-usage-test-rehearsal-1";
  const plan = {
    resources: {
      Usage: {
        action: "delete",
        state: {
          resourceType: "Cloudflare.Workflow",
          attr: {
            workflowName: own,
            scriptName: "basalt-rehearsal-api-test-rehearsal-1",
            accountId: ACCOUNT,
          },
        },
      },
    },
    deletions: {},
  };
  const run = await guarded(t, { deletable: destroyTargets(plan as never) }, () =>
    Effect.gen(function* () {
      const mine = yield* Effect.exit(
        Workflows.deleteWorkflow({ accountId: ACCOUNT, workflowName: own }),
      );
      const other = yield* Effect.exit(
        Workflows.deleteWorkflow({ accountId: ACCOUNT, workflowName: "basalt-production-usage" }),
      );
      // The host Worker the row records is not a Workflow target.
      const host = yield* Effect.exit(
        Workflows.deleteWorkflow({
          accountId: ACCOUNT,
          workflowName: "basalt-rehearsal-api-test-rehearsal-1",
        }),
      );
      return { mine, other, host };
    }),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  assert.ok(Exit.isSuccess(run.exit.value.mine));
  assert.equal(refusalOf(run.exit.value.other).resource, "Workflow basalt-production-usage");
  assert.equal(
    refusalOf(run.exit.value.host).resource,
    "Workflow basalt-rehearsal-api-test-rehearsal-1",
  );
  assert.deepEqual(reads(run.received), [`DELETE /accounts/${ACCOUNT}/workflows/${own}`]);
});

test("a destroy plan's PlanetScale role and branch admit those deletes, never the database", async (t) => {
  const { destroyTargets } = await import("./plan-summary.ts");
  const database = "basalt-preview-rehearsal-1";
  const plan = {
    resources: {
      Role: {
        action: "delete",
        state: {
          resourceType: "Planetscale.PostgresRole",
          attr: {
            id: "role-own",
            name: "pscale_api_x",
            database,
            branch: "test-rehearsal-1",
            databaseName: "postgres",
          },
        },
      },
      Branch: {
        action: "delete",
        state: {
          resourceType: "Planetscale.PostgresBranch",
          attr: { name: "test-rehearsal-1", database, organization: "org" },
        },
      },
    },
    deletions: {},
  };
  const at = (base: string, path: string) =>
    Effect.exit(
      Effect.tryPromise(() =>
        fetch(`${base}/v1/organizations/org/databases/${path}`, { method: "DELETE" }),
      ),
    );
  const run = await guarded(t, { deletable: destroyTargets(plan as never) }, (base) =>
    Effect.gen(function* () {
      return {
        role: yield* at(base, `${database}/branches/test-rehearsal-1/roles/role-own`),
        otherRole: yield* at(base, `${database}/branches/test-rehearsal-1/roles/role-other`),
        branch: yield* at(base, `${database}/branches/test-rehearsal-1`),
        otherBranch: yield* at(base, `${database}/branches/main`),
        database: yield* at(base, database),
        production: yield* at(base, "basalt/branches/main/roles/role-own"),
      };
    }),
  );
  assert.ok(Exit.isSuccess(run.exit));
  const value = run.exit.value;
  assert.ok(Exit.isSuccess(value.role) && Exit.isSuccess(value.branch));
  assert.equal(
    refusalOf(value.otherRole).resource,
    `PlanetScale role ${database}/branches/test-rehearsal-1/roles/role-other`,
  );
  assert.equal(
    refusalOf(value.otherBranch).resource,
    `PlanetScale branch ${database}/branches/main`,
  );
  assert.equal(refusalOf(value.database).resource, `PlanetScale database ${database}`);
  // The role id the plan records, on production's database, is not the plan's role.
  assert.equal(
    refusalOf(value.production).resource,
    "PlanetScale role basalt/branches/main/roles/role-own",
  );
  assert.deepEqual(reads(run.received), [
    `DELETE /v1/organizations/org/databases/${database}/branches/test-rehearsal-1/roles/role-own`,
    `DELETE /v1/organizations/org/databases/${database}/branches/test-rehearsal-1`,
  ]);
});
