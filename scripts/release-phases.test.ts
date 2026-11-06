import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { discoverReleasePhaseProof } from "./architecture/native-stack.ts";
import { deployInPhases } from "./release-phases/deploy.ts";
import {
  checkReleaseHeadroom,
  primaryHeadroom,
  releaseDatabasePolicy,
} from "./release-phases/headroom.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const now = Date.parse("2026-11-06T10:00:00Z");
const metrics = (used: number) => ({
  branch: { name: "main" },
  metrics: [
    {
      metric: "planetscale_postgres_connection_state",
      values: [
        { pod: "primary", role: "primary", value: used },
        { pod: "replica", role: "replica", value: 100 },
      ],
    },
    {
      metric: "planetscale_postgres_settings_max_connections",
      values: [
        { pod: "primary", role: "primary", value: 25 },
        { pod: "replica", role: "replica", value: 25 },
      ],
    },
  ],
});
const environment = {
  PLANETSCALE_ORGANIZATION: "fixture",
  PLANETSCALE_DATABASE_NAME: "fixture",
  PLANETSCALE_API_TOKEN_ID: "fixture",
  PLANETSCALE_API_TOKEN: "fixture",
  ALCHEMY_STAGE: "production",
};

test("release admission refuses 20/22 and admits 14/22 with the configured seven-client envelope", () => {
  assert.equal(
    Object.values(releaseDatabasePolicy.connections).reduce((sum, value) => sum + value, 0),
    7,
  );
  assert.throws(
    () => primaryHeadroom(metrics(20), "main"),
    /primary total 20, release envelope 7, ordinary slots 22/,
  );
  assert.deepEqual(primaryHeadroom(metrics(14), "main"), {
    observed: 14,
    ordinarySlots: 22,
    envelope: 7,
  });
  assert.deepEqual(primaryHeadroom(metrics(15), "main"), {
    observed: 15,
    ordinarySlots: 22,
    envelope: 7,
  });
  assert.throws(() => primaryHeadroom(metrics(16), "main"), /refused/);
  const raisedLimit = metrics(20);
  raisedLimit.metrics[1]!.values[0]!.value = 40;
  assert.throws(() => primaryHeadroom(raisedLimit, "main"), /max 40, configured max 25/);
});

test("missing, duplicate, mismatched and invalid primary metrics fail closed", () => {
  for (const invalid of [
    (v: ReturnType<typeof metrics>) => {
      v.metrics[0]!.values.shift();
    },
    (v: ReturnType<typeof metrics>) => {
      v.metrics[0]!.values.push(v.metrics[0]!.values[0]!);
    },
    (v: ReturnType<typeof metrics>) => {
      v.metrics[1]!.values[0]!.pod = "different";
    },
    (v: ReturnType<typeof metrics>) => {
      v.metrics[0]!.values[0]!.value = -1;
    },
    (v: ReturnType<typeof metrics>) => {
      v.metrics[1]!.values[0]!.value = Number.NaN;
    },
    (v: ReturnType<typeof metrics>) => {
      v.branch.name = "other";
    },
  ]) {
    const input = metrics(14);
    invalid(input);
    assert.throws(() => primaryHeadroom(input, "main"), /refused/);
  }
});

test("preflight reads only the instant HTTP API and refuses stale or failed responses", async () => {
  const requests: URL[] = [];
  const fetchMetrics: typeof fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(init?.redirect, "error");
    const url = new URL(String(input));
    requests.push(url);
    return Response.json(metrics(14), { headers: { date: new Date(now).toUTCString() } });
  };
  await checkReleaseHeadroom(environment, { fetch: fetchMetrics, now: () => now });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]!.pathname,
    "/v1/organizations/fixture/databases/fixture/branches/main/metrics/instant",
  );
  assert.deepEqual(requests[0]!.searchParams.getAll("metrics[]"), [
    "planetscale_postgres_connection_state",
    "planetscale_postgres_settings_max_connections",
  ]);
  for (const response of [
    Response.json(metrics(14)),
    Response.json(metrics(14), { headers: { date: new Date(now - 60_000).toUTCString() } }),
    Response.json(metrics(14), { headers: { date: new Date(now).toUTCString(), age: "60" } }),
    Response.json(metrics(14), { status: 403 }),
  ])
    await assert.rejects(
      checkReleaseHeadroom(environment, { fetch: async () => response, now: () => now }),
      /refused/,
    );
  await assert.rejects(
    checkReleaseHeadroom(environment, {
      fetch: async () => {
        throw new Error("private detail");
      },
    }),
    (error) => {
      assert.doesNotMatch(String(error), /private detail/);
      return true;
    },
  );
});

test("a preflight or filtered deploy failure never starts the application deploy", async () => {
  for (const failsPreflight of [true, false]) {
    const calls: string[][] = [];
    await assert.rejects(
      deployInPhases({
        cloud: "fixture",
        environment,
        sharedFoundation: true,
        preflight: async () => {
          if (failsPreflight) throw new Error("headroom");
          return { observed: 14, ordinarySlots: 22, envelope: 7 };
        },
        execute: (_command, args) => {
          calls.push(args);
          throw new Error("53300");
        },
      }),
    );
    assert.equal(calls.length, failsPreflight ? 0 : 1);
    if (!failsPreflight) assert.deepEqual(calls[0]!.slice(-2), ["--include", "PoolDatabase"]);
  }
  const attempts: string[] = [];
  const calls: string[][] = [];
  const execute = (
    _command: string,
    args: string[],
    _cwd?: string,
    settings?: NodeJS.ProcessEnv,
  ) => {
    calls.push(args);
    attempts.push(settings!.BASALT_RELEASE_ATTEMPT!);
  };
  for (let i = 0; i < 2; i++)
    await deployInPhases({
      cloud: "fixture",
      environment,
      sharedFoundation: true,
      preflight: async () => ({ observed: 14, ordinarySlots: 22, envelope: 7 }),
      execute,
    });
  assert.deepEqual(calls[0]!.slice(-2), ["--include", "PoolDatabase"]);
  assert.ok(calls[1]!.includes("alchemy.app-domains.ts"));
  assert.ok(!calls[2]!.includes("--include"));
  assert.equal(attempts[0], attempts[1]);
  assert.equal(attempts[1], attempts[2]);
  assert.notEqual(attempts[2], attempts[3]);
});

test(
  "the real root stack isolates migrate 53300, orders DB steps and memoizes pass two",
  { timeout: 40_000 },
  () => {
    const proof = discoverReleasePhaseProof(root);
    const migration = proof.resources.find((node) => node.id === "Migrations")!;
    const pool = proof.resources.find((node) => node.id === "PoolDatabase")!;
    assert.ok(
      migration.dependencies.includes("RuntimeDatabaseBudget"),
      "Migrations must consume budget.hash",
    );
    assert.ok(
      pool.dependencies.includes("Migrations"),
      "PoolDatabase must consume the migration hash",
    );
    assert.deepEqual(proof.failed, ["Migrations:53300"]);
    assert.ok(!proof.applied.includes("PoolDatabase"));
    const applicationResources = proof.resources.filter(
      (node) =>
        node.type === "Cloudflare.Worker" ||
        node.type === "Cloudflare.ContainerApplication" ||
        ["Site", "PoolImagePublicationReceipt"].includes(node.id),
    );
    for (const id of [
      "Api",
      "Router",
      "PoolWorker",
      "Site",
      "PoolContainer",
      "PoolImagePublicationReceipt",
    ])
      assert.ok(
        applicationResources.some((node) => node.id === id),
        `The real graph must include ${id}`,
      );
    assert.ok(
      applicationResources.length >= 15,
      "The proof must cover the actual Workers, Site, container and receipt",
    );
    for (const node of applicationResources) {
      assert.ok(!proof.selected.includes(node.id), `${node.id} must be outside the DB phase`);
      assert.ok(!proof.applied.includes(node.id), `${node.id} must remain unapplied`);
    }
    assert.deepEqual(
      proof.dbSecondPass.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: "Migrations", action: "noop" },
        { id: "PoolDatabase", action: "noop" },
        { id: "RuntimeDatabaseBudget", action: "noop" },
      ],
    );
    assert.ok(proof.nextAttempt.every((node) => node.action === "update"));
  },
);
