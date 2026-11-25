import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseRefusal, retirePlan, retireSubject } from "./retire-stage.ts";

const database = (name: string, id = `id-${name}`) => ({
  path: `basalt-preview-database/test-rehearsal-1234/PreviewDatabaseParent`,
  value: { resourceType: "Planetscale.PostgresDatabase", attr: { id, name, organization: "org" } },
});

test("a run may take only stages holding buckets and their own database, named by ordinal", () => {
  const { lines, candidates } = retirePlan([
    {
      stage: "test-rehearsal-1111",
      stacks: {
        "basalt-rehearsal": { "Cloudflare.Worker": 18, "Cloudflare.Hyperdrive.Config": 2 },
        "basalt-preview-database": { "Planetscale.PostgresDatabase": 1 },
      },
    },
    { stage: "test-rehearsal-2222", stacks: {}, unreadable: "basalt-rehearsal: malformed" },
    {
      stage: "test-rehearsal-3333",
      stacks: { "basalt-preview-database": { "Planetscale.PostgresDatabase": 1, output: 1 } },
    },
    { stage: "test-rehearsal-4444", stacks: { "basalt-rehearsal": { "Cloudflare.R2.Bucket": 3 } } },
  ]);
  assert.deepEqual(candidates, [
    { ordinal: 3, stage: "test-rehearsal-3333" },
    { ordinal: 4, stage: "test-rehearsal-4444" },
  ]);
  assert.deepEqual(lines, [
    "  stage 1: basalt-rehearsal: Cloudflare.Worker 18, Cloudflare.Hyperdrive.Config 2; basalt-preview-database: Planetscale.PostgresDatabase 1 (left: this path cannot delete Cloudflare.Hyperdrive.Config, Cloudflare.Worker)",
    "  stage 2: no rows (left: its State could not be read)",
    "  stage 3: basalt-preview-database: Planetscale.PostgresDatabase 1, output 1 (retirable)",
    "  stage 4: basalt-rehearsal: Cloudflare.R2.Bucket 3 (retirable)",
  ]);
  // The public lines name no stage.
  assert.ok(lines.every((line) => !/test-rehearsal-\d/u.test(line)));
  assert.deepEqual(retirePlan([]).candidates, []);
});

test("a stage's destroy deletes only its own database, never one production's State records", () => {
  const own = "basalt-preview-rehearsal-1234";
  const production = [{ id: "prod-id", name: "basalt" }];
  assert.equal(databaseRefusal([database(own)], own, production), undefined);
  // Buckets and outputs carry no database to prove.
  assert.equal(databaseRefusal([{ path: "x/output", value: null }], own, production), undefined);
  for (const [why, row] of [
    ["another stage's database", database("basalt-preview-rehearsal-5678")],
    ["production's name", database("basalt")],
    ["production's id under this stage's name", database(own, "prod-id")],
    [
      "a row with no name",
      { path: "p", value: { resourceType: "Planetscale.PostgresDatabase", attr: {} } },
    ],
  ] as const)
    assert.ok(databaseRefusal([row], own, production), why);
  // The stage's own name, which production happens to record: refused all the same.
  assert.ok(databaseRefusal([database(own)], own, [{ name: own }]));
});

test("only a four-digit rehearsal stage is retired", () => {
  assert.deepEqual(retireSubject("test-rehearsal-1234"), { kind: "rehearsal", number: 1234 });
  for (const stage of ["test-rehearsal-1", "test-rehearsal-12345", "test-pr-1234", "production"])
    assert.throws(() => retireSubject(stage), stage);
});
