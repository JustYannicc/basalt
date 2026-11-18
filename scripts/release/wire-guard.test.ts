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
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { install, selfTest, WireRefused, type WireGuardConfig } from "./wire-guard.ts";
import {
  ACCOUNT,
  MAIN,
  MAIN_SOURCE,
  POOL_WORKER,
  applicationBody,
  credentials,
  poolWorkerUpload,
  startServer,
} from "./test/wire-guard-fixture.ts";

const CUTOVER = ["PoolRuntimeBlue", "PoolRuntimeGreen"];

/** Runs `run` through the real FetchHttpClient and real fetch with the guard installed. */
const guarded = async <A, E>(
  context: TestContext,
  config: WireGuardConfig,
  run: (base: string) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
) => {
  const server = await startServer();
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

test("the cutover migration is delivered when PoolWorker's allow-list names both classes", async (t) => {
  const run = await guarded(t, { sqliteClasses: { [POOL_WORKER]: CUTOVER } }, () =>
    Workers.putScript(poolWorkerUpload({ newSqliteClasses: CUTOVER })),
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
  assert.deepEqual([refused.field, refused.value], ["application id", "legacy-root-app"]);
  assert.deepEqual(
    run.received.map((request) => `${request.method} ${request.path}`),
    [
      `POST /accounts/${ACCOUNT}/containers/applications`,
      `DELETE /accounts/${ACCOUNT}/containers/applications/app-created-in-run`,
    ],
  );
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
