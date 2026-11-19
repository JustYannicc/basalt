import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigProvider, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  configureDatabasePoolBudget,
  ownPoolBudgetTarget,
} from "../../.upstream/apps/hosted/cloud/scripts/database-pool-budget.ts";
import { previewPoolDatabaseBranch } from "../../src/pool/database-settings.ts";
import { previewIdentity } from "../environment.ts";
import { databasePoolParameters } from "../../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-policy.ts";

function run(
  options: {
    existing?: boolean;
    readback?: boolean;
    status?: number;
    mode?: string;
    nullableCatalog?: "initial" | "readback" | "both";
    nullBudgetReadback?: boolean;
    /** Production's own target unless a test names another. */
    target?: { stage?: string; database: string; branch: string };
  } = {},
) {
  const target = options.target ?? { stage: "production", database: "fixture", branch: "main" };
  const requests: { method: string; path: string; body?: unknown }[] = [];
  let reads = 0;
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ method: request.method, path, body });
      const parameters = Object.entries(databasePoolParameters).map(([name, value]) => ({
        namespace: "pgbouncer",
        name,
        value,
      }));
      parameters.push({
        namespace: "pgbouncer",
        name: "pool_mode",
        value: options.mode ?? "transaction",
      });
      let data: unknown = path.endsWith("parameters")
        ? (++reads === 1 && !options.existing) || (reads > 1 && options.readback === false)
          ? parameters.filter((row) => row.name !== "max_db_connections")
          : parameters
        : request.method === "PATCH"
          ? { id: "change", state: "completed", started_at: null, previous_parameters: null }
          : { data: [{ id: "change", state: "completed", started_at: null }] };
      if (Array.isArray(data) && options.nullableCatalog) {
        const includeNulls =
          options.nullableCatalog === "both" ||
          (reads === 1
            ? options.nullableCatalog === "initial"
            : options.nullableCatalog === "readback");
        data = [
          ...data,
          ...Array.from({ length: 183 - data.length }, (_, index) => ({
            namespace: "pgconf",
            name: `unrelated_${index}`,
            value: "default",
          })),
          { namespace: "pgconf", name: "pginsights.enabled", value: includeNulls ? null : "off" },
          {
            namespace: "pgconf",
            name: "pginsights.bgworker_threads",
            value: includeNulls ? null : "0",
          },
        ];
      }
      if (Array.isArray(data) && reads > 1 && options.nullBudgetReadback) {
        data = data.map((row) =>
          row.name === "max_db_connections" ? { ...row, value: null } : row,
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        Response.json(data, { status: options.status ?? 200 }),
      );
    }),
  );
  return {
    requests,
    result: Effect.runPromise(
      configureDatabasePoolBudget.pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            PLANETSCALE_ORGANIZATION: "fixture",
            ...(target.stage === undefined ? {} : { POOL_BUDGET_STAGE: target.stage }),
            POOL_BUDGET_DATABASE: target.database,
            POOL_BUDGET_BRANCH: target.branch,
            PLANETSCALE_API_TOKEN_ID: "fixture",
            PLANETSCALE_API_TOKEN: "fixture",
          }),
        ),
      ),
    ),
  };
}

test("deploy applies the shared cap and bounded retirement, waits for completion, and checks readback", async () => {
  const proof = run();
  await proof.result;
  assert.deepEqual(
    proof.requests.map((request) => request.method),
    ["GET", "PATCH", "GET", "GET"],
  );
  assert.deepEqual(proof.requests[1]!.body, { parameters: { pgbouncer: databasePoolParameters } });
  const unchanged = run({ existing: true });
  await unchanged.result;
  assert.deepEqual(
    unchanged.requests.map((request) => request.method),
    ["GET"],
  );
});

test("invalid pool mode, failed API response and false readback stop deployment", async () => {
  for (const options of [{ mode: "session" }, { status: 403 }, { readback: false }])
    await assert.rejects(run(options).result);
});

for (const nullableCatalog of ["initial", "readback", "both"] as const) {
  test(`deploy accepts a 185-row catalog with unrelated null values on ${nullableCatalog} reads`, async () => {
    const proof = run({ nullableCatalog });
    await proof.result;
    assert.deepEqual(
      proof.requests.map((request) => request.method),
      ["GET", "PATCH", "GET", "GET"],
    );
    assert.deepEqual(proof.requests[1]!.body, {
      parameters: { pgbouncer: databasePoolParameters },
    });
  });
}

test("an already configured budget accepts unrelated null catalog values without a write", async () => {
  const unchanged = run({ existing: true, nullableCatalog: "both" });
  await unchanged.result;
  assert.deepEqual(
    unchanged.requests.map((request) => request.method),
    ["GET"],
  );
});

test("a null required budget value on readback still refuses deployment", async () => {
  await assert.rejects(run({ nullBudgetReadback: true }).result);
});

const stage = "test-rehearsal-2";
const own = { stage, database: "basalt-preview-rehearsal-2", branch: stage };
const notItsOwn = {
  "production's database and branch": { stage, database: "fixture-production", branch: "main" },
  "its own database's main branch": { ...own, branch: "main" },
  "another stage's branch": { ...own, branch: "test-rehearsal-1-pool" },
  "another stage's database": { ...own, database: "basalt-preview-rehearsal-1" },
  "a test stage of an unknown kind": {
    stage: "test-e2e-1",
    database: "basalt-preview-e2e-1",
    branch: "test-e2e-1",
  },
  "a test branch from production": { stage: "production", database: "fixture", branch: stage },
  "no stage at all": { database: "fixture", branch: "main" },
};

for (const [name, target] of Object.entries(notItsOwn))
  test(`the budget refuses ${name} before any provider call`, async () => {
    const proof = run({ existing: true, target });
    await assert.rejects(proof.result);
    assert.deepEqual(proof.requests, []);
  });

test("a test stage reaches the provider only for its own database and its two branches", async () => {
  for (const branch of [stage, `${stage}-pool`]) {
    const proof = run({ existing: true, target: { ...own, branch } });
    await proof.result;
    assert.deepEqual(
      proof.requests.map((request) => request.path),
      [`/v1/organizations/fixture/databases/${own.database}/branches/${branch}/parameters`],
    );
  }
});

test("the script's rule accepts exactly the names the stage tooling gives a stage", () => {
  const identity = previewIdentity(7, { TEST_STAGE_DOMAIN: "example.invalid" });
  for (const branch of [identity.stage, previewPoolDatabaseBranch(identity.stage)])
    assert.equal(ownPoolBudgetTarget(identity.stage, identity.databaseName, branch), true);
  assert.equal(ownPoolBudgetTarget(identity.stage, identity.databaseName, "main"), false);
  assert.equal(ownPoolBudgetTarget("production", identity.databaseName, "main"), true);
});

test("the real script exits non-zero with a closed error and sends nothing", () => {
  const directory = mkdtempSync(join(tmpdir(), "pool-budget-guard-"));
  const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
  // Any request the script sends is recorded and then refused, so no test reaches a provider.
  const preload = `data:text/javascript,${encodeURIComponent(
    `import { writeFileSync } from "node:fs";
     globalThis.fetch = async () => {
       writeFileSync(process.env.FIXTURE_REQUEST_MARKER, "sent");
       throw new TypeError("fixture network");
     };`,
  )}`;
  const script = (name: string, target: { stage?: string; database: string; branch: string }) => {
    const marker = join(directory, `${name}.sent`);
    const result = spawnSync(
      process.execPath,
      ["--import", preload, "scripts/database-pool-budget.ts"],
      {
        cwd: cloud,
        encoding: "utf8",
        timeout: 30_000,
        // No inherited credentials or configuration can reach this process.
        env: {
          PATH: process.env.PATH,
          FIXTURE_REQUEST_MARKER: marker,
          PLANETSCALE_ORGANIZATION: "fixture",
          PLANETSCALE_API_TOKEN_ID: "fixture",
          PLANETSCALE_API_TOKEN: "fixture",
          ...(target.stage === undefined ? {} : { POOL_BUDGET_STAGE: target.stage }),
          POOL_BUDGET_DATABASE: target.database,
          POOL_BUDGET_BRANCH: target.branch,
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return { ...result, sent: existsSync(marker) };
  };
  try {
    const refused = script("refused", notItsOwn["production's database and branch"]);
    assert.equal(refused.status, 1, refused.stderr);
    // The deploy reports a command's stderr only, so the whole reason has to be there.
    assert.equal(
      refused.stderr,
      "The database budget refuses a database or branch that is not its stage's own\n",
    );
    assert.doesNotMatch(refused.stdout + refused.stderr, /fixture-production/);
    assert.equal(refused.sent, false);
    const unnamed = script("unnamed", notItsOwn["no stage at all"]);
    assert.equal(unnamed.status, 1, unnamed.stderr);
    assert.match(unnamed.stderr, /^The database budget failed: [A-Za-z]+\n$/);
    assert.equal(unnamed.sent, false);
    // The same harness lets a stage's own target through, so the refusal above is the guard's.
    const allowed = script("allowed", own);
    assert.equal(allowed.status, 1, allowed.stderr);
    assert.equal(allowed.stderr, "PlanetScale request failed\n");
    assert.equal(allowed.sent, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
