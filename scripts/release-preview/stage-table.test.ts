import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, stageTable, type ProviderReads } from "./stage-table.ts";

const whole = {
  stage: "test-rehearsal-2",
  stacks: {
    "basalt-rehearsal": {
      "Cloudflare.Worker": 18,
      "Cloudflare.Container": 1,
      "Planetscale.PostgresBranch": 2,
    },
    "basalt-preview-database": {},
  },
  containers: ["app-2"],
  branches: [
    { database: "basalt-preview-rehearsal-2", name: "main" },
    { database: "basalt-preview-rehearsal-2", name: "test-rehearsal-2-pool" },
  ],
};

test("each stage is classed from its own State rows", () => {
  assert.equal(classify(whole), "whole");
  assert.equal(
    classify({ stage: "s", stacks: { a: { "Cloudflare.R2.Bucket": 3, output: 1 } } }),
    "buckets-only",
  );
  assert.equal(
    classify({ stage: "s", stacks: { a: { "Planetscale.PostgresDatabase": 1 } } }),
    "database-only",
  );
  assert.equal(
    classify({
      stage: "s",
      stacks: { a: { "Planetscale.PostgresDatabase": 1, "Cloudflare.R2.Bucket": 1 } },
    }),
    "buckets and database",
  );
  assert.equal(classify({ stage: "s", stacks: { a: { output: 1 } } }), "empty");
  assert.equal(classify({ stage: "s", stacks: {}, unreadable: "x" }), "unreadable");
});

test("the table reads the provider only for whole stages, and names no four-digit stage or id", async () => {
  const asked: string[] = [];
  const reads: ProviderReads = {
    async application(id) {
      asked.push(id);
      return { configured: 1, active: 1 };
    },
    async branch(database, name) {
      asked.push(name);
      return name === "main" ? { state: "ready" } : "absent";
    },
  };
  const lines = await stageTable(
    [
      whole,
      { stage: "test-rehearsal-3", stacks: { "basalt-rehearsal": { "Cloudflare.R2.Bucket": 2 } } },
      {
        stage: "test-rehearsal-1234",
        stacks: { "basalt-preview-database": { "Planetscale.PostgresDatabase": 1 } },
      },
    ],
    reads,
  );
  assert.deepEqual(asked, ["app-2", "main", "test-rehearsal-2-pool"]);
  assert.deepEqual(lines, [
    "  lane 2: whole; basalt-rehearsal: Cloudflare.Worker 18, Cloudflare.Container 1, Planetscale.PostgresBranch 2; basalt-preview-database: none; container 1 instance(s) configured, 1 active; Postgres branches: 1 of 2 exist",
    "  lane 3: buckets-only; basalt-rehearsal: Cloudflare.R2.Bucket 2",
    "  stage 1: database-only; basalt-preview-database: Planetscale.PostgresDatabase 1",
  ]);
  assert.ok(lines.every((line) => !/1234|app-2/u.test(line)));
});
