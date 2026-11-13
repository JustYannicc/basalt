import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AlchemyContext } from "alchemy/AlchemyContext";
import type { BundleOutput } from "alchemy/Bundle/Bundle";
import { Effect, type FileSystem, type Path } from "effect";
import { Miniflare } from "../pool-test-runtime/index.ts";
import { seriesFixture, pool } from "./series-fixture.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { openEnvelope, signEnvelope } from "../../src/pool/token.ts";
import { parseBulkUsageImport } from "../../src/pool/model-history/import.ts";
import { bulkDefinition, bulkImportPath } from "../../src/pool/model-history/bulk-contract.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const signingKey = "ab".repeat(32);
const identity = { pool, organization: "fixture-org", owner: "fixture-owner" };

async function sharedWorker() {
  const entry = import.meta.resolve("alchemy");
  const module = new URL(
    `Cloudflare/Workers/Sources/Rolldown${entry.endsWith(".ts") ? ".ts" : ".js"}`,
    new URL("./", entry),
  );
  const {
    WorkerBundle,
  }: {
    readonly WorkerBundle: Effect.Effect<
      {
        readonly build: (options: object) => Effect.Effect<BundleOutput, Error>;
      },
      never,
      FileSystem.FileSystem | Path.Path
    >;
  } = await import(module.href);
  const directory = await mkdtemp(join(tmpdir(), "basalt-bulk-shared-"));
  let intercepted = 0;
  let complete = false;
  try {
    const bundle = await Effect.runPromise(
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return yield* bundler.build({
          id: "BulkSharedFixture",
          main: root + "scripts/pool-tests/bulk-shared-runtime.fixture.mjs",
          compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
          entry: { kind: "external" },
          stack: { name: "basalt", stage: "production" },
          extraOptions: {
            input: {
              plugins: [
                {
                  name: "bulk-shared-importable-env",
                  resolveId: {
                    order: "pre",
                    handler(source: string, importer?: string) {
                      if (
                        source !== "cloudflare:workers" ||
                        !importer ||
                        !/[/\\]cloudflare_workers\.(ts|js)$/.test(importer)
                      )
                        return null;
                      intercepted++;
                      return root + "scripts/pool-tests/bulk-shared-env.fixture.mjs";
                    },
                  },
                },
              ],
            },
            output: { dir: directory, sourcemap: false },
          },
        });
      }).pipe(
        Effect.provideService(AlchemyContext, { dotAlchemy: directory, dev: false, adopt: false }),
        Effect.provide(NodeServices.layer),
      ),
    );
    assert.equal(intercepted, 1, "Only Alchemy's importable-env boundary may be adapted");
    for (const file of bundle.files) {
      if (typeof file.content !== "string") continue;
      for (const optional of ["@vitejs/devtools/config", "@alchemy.run/frontend-frameworks/core"])
        assert.ok(
          !file.content.includes(optional),
          `Infrastructure-only import survived native DCE: ${optional}`,
        );
    }
    const modules = bundle.files.map((file) => ({
      type: file.path.endsWith(".wasm") ? ("CompiledWasm" as const) : ("ESModule" as const),
      path: join(directory, file.path),
      contents: file.content,
    }));
    complete = true;
    return { modulesRoot: "/", modules };
  } finally {
    if (complete) await rm(directory, { recursive: true, force: true });
    else console.error(JSON.stringify({ proof: "shared-bundle-failure", directory }));
  }
}

async function plan() {
  const source = randomUUID();
  const data = JSON.stringify({
    event_hash: "1".padStart(64, "0"),
    timestamp: "2026-01-01T00:30:00.000000001Z",
    failed: false,
    provider: "codex",
    model: "fixture-model",
    endpoint: "/v1/responses",
    input_tokens: "100",
    output_tokens: "10",
    total_tokens: "110",
  });
  const parsed = await parseBulkUsageImport(
    { source, format: "cpamp-v1-jsonl", data, accountMappings: [] },
    { pool, person: identity.owner },
  );
  const input = {
    operation: "begin",
    accountMappings: [],
    manifest: {
      version: 1,
      source,
      sourceHash: await digest(data),
      approvedManifestSha256: await digest("fixture-approved-manifest"),
      accountMappingDigest: await digest("[]"),
      totalRows: 1,
      chunks: [
        {
          sha256: await digest(data),
          idsSha256: await digest(JSON.stringify(parsed.records.map((row) => row.id))),
          rows: 1,
          bytes: new TextEncoder().encode(data).length,
        },
      ],
    },
  };
  return { input, definition: await bulkDefinition(input, identity), data };
}

test("the carried shared coordinator runs HTTP, isolation and recovered alarms with lazy env bindings", async () => {
  await seriesFixture(async ({ db, schema }) => {
    const database = new URL(process.env.POOL_TEST_ADMIN_URL!);
    database.searchParams.delete("options");
    const login = `${schema}_shared`;
    await db.query(`CREATE ROLE ${login} LOGIN PASSWORD 'fixture-only' IN ROLE basalt_pool_owner`);
    await db.query(`ALTER ROLE ${login} SET search_path TO ${schema}`);
    await db.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${login}`);
    database.username = login;
    database.password = "fixture-only";
    let admissions = 0;
    let worker: InstanceType<typeof Miniflare> | undefined;
    try {
      worker = new Miniflare({
        workers: [
          {
            name: "shared",
            compatibilityDate: "2026-09-08",
            compatibilityFlags: ["nodejs_compat"],
            ...(await sharedWorker()),
            bindings: {
              ALCHEMY_STACK_NAME: "basalt",
              ALCHEMY_STAGE: "production",
              ALCHEMY_CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
              CLOUD_SOURCE_NAMESPACE: "fixture-apps",
              EXECUTOR_ENCRYPTION_KEY: "cd".repeat(32),
              POOL_APP_SIGNING_KEY: signingKey,
            },
            hyperdrives: { POOL_AUTH_DATABASE: database.toString() },
            durableObjects: {
              ArtifactsTokenCoordinator: {
                className: "ArtifactsTokenCoordinator",
                useSQLite: true,
              },
            },
            r2Buckets: ["VaultAttachments"],
            serviceBindings: {
              TOOLS_SERVICE: async (request: Request) => {
                assert.equal(
                  new URL(request.url).pathname,
                  "/api/internal/pool-usage-import-admission",
                );
                const body = (await request.json()) as { envelope: string };
                const assertion = (await openEnvelope(signingKey, "sbq1", body.envelope)) as Record<
                  string,
                  unknown
                >;
                assert.equal(assertion.action, "usageImportAdmission");
                for (const key of ["pool", "organization", "owner"] as const)
                  assert.equal(assertion[key], identity[key]);
                admissions++;
                return new Response(null, { status: 204 });
              },
            },
            outboundService: async () => {
              throw new Error("Unexpected outbound HTTP from the shared coordinator fixture");
            },
          },
        ],
      });
      await worker.ready;
      const runtime = await worker.getWorker("shared");
      const fixture = await plan();
      const job = fixture.definition.job;
      const control = async (path: string, body?: object, object?: string) => {
        const url = new URL(`https://shared.test/__fixture/${path}`);
        url.searchParams.set("job", job);
        if (object) url.searchParams.set("object", object);
        return runtime.fetch(
          url.toString(),
          body ? { method: "POST", body: JSON.stringify(body) } : {},
        );
      };
      const observation = async () =>
        (await (await control("env")).json()) as {
          hiddenKeys: string[];
          enumerableKeys: string[];
          reads: Record<string, number>;
          artifactReads: number;
          jurisdictionCalls: number;
          nativeIdCalls: number;
        };
      const post = async (input: object, expected = 200, object?: string) => {
        const envelope = await signEnvelope(signingKey, "sbs1", {
          action: "importUsageBulk",
          ...identity,
          user: identity.owner,
          expiresAt: Date.now() + 25_000,
          input,
        });
        const url = new URL(`https://shared.test${bulkImportPath}`);
        url.searchParams.set("job", job);
        if (object) url.searchParams.set("object", object);
        const response = await runtime.fetch(url.toString(), {
          method: "POST",
          body: JSON.stringify({ envelope }),
        });
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(response.status, expected, JSON.stringify(body));
        return body;
      };
      const before = await observation();
      assert.ok(before.hiddenKeys.every((key) => !before.enumerableKeys.includes(key)));
      assert.ok(Object.values(before.reads).every((value) => value === 0));

      const sourceCalls: [string, unknown[]][] = [
        ["acquire", ["code_fixture", null, null]],
        ["history", ["code_fixture", 1, null]],
        ["resolve", ["code_fixture", "main", null]],
        ["tree", ["code_fixture", "a".repeat(40), null]],
        ["blobs", ["code_fixture", ["a".repeat(40)], "sizes", 1, null]],
        ["file", ["code_fixture", "a".repeat(40), "file.txt", null]],
        ["create", ["code_fixture", null]],
      ];
      for (const [method, args] of sourceCalls) {
        const response = await control("rpc", { method, args });
        const refusal = (await response.json()) as {
          _tag: string;
          error: { _tag: string; reason: string };
        };
        assert.equal(refusal._tag, "~alchemy/rpc/error", method);
        assert.equal(refusal.error._tag, "SourceError", method);
        assert.equal(refusal.error.reason, "git", method);
      }
      const vault = await (
        await control("rpc", { method: "vault", args: ["fixture", { method: "list", input: {} }] })
      ).json();
      assert.deepEqual(vault, {
        ok: false,
        error: { _tag: "DriveRequestFailed", reason: "denied" },
      });
      const afterRpc = await observation();
      assert.equal(afterRpc.artifactReads, 0);
      assert.ok(
        Object.values(afterRpc.reads).every((value) => value === 0),
        "Source/vault refusal must not initialize import bindings",
      );

      for (const object of [`bulk-usage-import:${"0".repeat(64)}`, "code_fixture", "vault:fixture"])
        await post({ operation: "status", job }, 401, object);
      const bucket = await worker.getR2Bucket("VaultAttachments", "shared");
      const vaultKey = "vault-fixture/attachments/objects/retained.json";
      await bucket.put(vaultKey, "retained vault bytes");
      await post(fixture.input);
      await post({ operation: "upload", job, chunk: 0, data: fixture.data });
      await post({
        operation: "approve",
        job,
        manifestDigest: fixture.definition.manifestDigest,
        accountMappingDigest: fixture.definition.accountMappingDigest,
      });
      const at = Date.now();
      await post({
        operation: "guard",
        job,
        observation: {
          observedAt: at,
          expiresAt: at + 90_000,
          ready: true,
          cpu: 50,
          cpuAt: at,
          releaseReadComplete: true,
          releaseWindowActive: false,
          poolErrors: 0,
          queryErrors: 0,
        },
      });
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
        0,
      );
      assert.equal((await control("prepare", {})).status, 204);
      const firstInstance = (await (await control("instance")).json()) as { instance: string };
      await (await control("evict").catch(() => undefined))?.body?.cancel();
      const nextInstance = (await (await control("instance")).json()) as { instance: string };
      assert.notEqual(nextInstance.instance, firstInstance.instance);
      assert.equal((await control("tick")).status, 204);
      assert.equal((await post({ operation: "status", job })).state, "completed");
      assert.equal(
        (await db.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
        1,
      );
      const stored = (await (await control("storage")).json()) as {
        keys: string[];
        hasPrepare: boolean;
      };
      assert.equal(stored.hasPrepare, true, "Import alarm must not consume Source preparation");
      assert.ok(!stored.keys.includes("credential"));
      assert.equal(admissions, 2);

      for (const object of ["code_fixture", "vault:fixture"]) {
        assert.equal((await control("marker", { job }, object)).status, 204);
        assert.equal((await control("tick", undefined, object)).status, 500);
      }
      const final = await observation();
      assert.equal(final.artifactReads, 0);
      for (const key of ["POOL_APP_SIGNING_KEY", "POOL_AUTH_DATABASE", "TOOLS_SERVICE"])
        assert.ok(final.reads[key]! > 0, `The real shared runtime must read ${key} lazily`);
      assert.ok(final.nativeIdCalls > 0);
      assert.ok(final.jurisdictionCalls > 0);
      assert.equal(await (await bucket.get(vaultKey))!.text(), "retained vault bytes");
      assert.equal(
        await (await bucket.get(`usage-import-v1/${job}/0.ndjson`))!.text(),
        fixture.data,
      );
      console.log(
        JSON.stringify({
          proof: "actual-carried-shared-coordinator",
          sourceRpcRefusals: sourceCalls.length,
          vaultRpcRefusals: 1,
          wrongObjectHttpRefusals: 3,
          wrongObjectAlarmRefusals: 2,
          evicted: true,
          sqlRows: 1,
          admissions,
          nativeIdCalls: final.nativeIdCalls,
          jurisdictionCalls: final.jurisdictionCalls,
          euResidencyProven: false,
        }),
      );
    } finally {
      await worker?.dispose();
      await db.query(`DROP OWNED BY ${login}`);
      await db.query(`DROP ROLE ${login}`);
    }
  });
});
