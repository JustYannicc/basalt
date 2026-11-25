import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseRefusal, ownershipRefusal, retirePlan, retireSubject } from "./retire-stage.ts";

const database = (name: string, id = `id-${name}`) => ({
  path: `basalt-preview-database/test-rehearsal-1234/PreviewDatabaseParent`,
  value: { resourceType: "Planetscale.PostgresDatabase", attr: { id, name, organization: "org" } },
});

test("a run may take any readable stage, whole ones included, named by ordinal", () => {
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
    { ordinal: 1, stage: "test-rehearsal-1111" },
    { ordinal: 3, stage: "test-rehearsal-3333" },
    { ordinal: 4, stage: "test-rehearsal-4444" },
  ]);
  assert.deepEqual(lines, [
    "  stage 1: basalt-rehearsal: Cloudflare.Worker 18, Cloudflare.Hyperdrive.Config 2; basalt-preview-database: Planetscale.PostgresDatabase 1 (retirable)",
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

// A whole four-digit stage's rows, as Alchemy records them for its stack and stage.
const stage = "test-rehearsal-1234";
const own = "basalt-preview-rehearsal-1234";
const instance = "ab".repeat(16);
const row = (resourceType: string, attr: Record<string, unknown>, logicalId = "X") => ({
  path: `basalt-rehearsal/${stage}/${logicalId}`,
  value: { resourceType, logicalId, instanceId: instance, attr },
});
// Cut to their limit by Alchemy, each keeps only a hash of its stage (computed once with Alchemy).
const ownCut = "basalt-rehearsal-poolcontainer-test-rehezbefejytvov2xk5lvov2xk5l";
const otherCut = "basalt-rehearsal-poolcontainer-test-rehes4wvc225vov2xk5lvov2xk5l";
const whole = [
  row("Cloudflare.Worker", {
    workerName: "basalt-rehearsal-api-test-rehearsal-1234-abcdefghijklmnop",
    routes: [
      { id: "route-1", pattern: "api.rehearsal-1234.preview.example.invalid/*", zoneId: "z" },
    ],
  }),
  row("Cloudflare.Workflow", {
    workflowName: "basalt-rehearsal-usage-test-rehearsal-1234",
    scriptName: "basalt-rehearsal-api-test-rehearsal-1234-abcdefghijklmnop",
    className: "AppWorkflows",
  }),
  row("Cloudflare.Container", { applicationId: "app-1", applicationName: ownCut }, "PoolContainer"),
  row("Cloudflare.DNS.Record", {
    recordId: "rec-1",
    name: "api.rehearsal-1234.preview.example.invalid",
  }),
  row(
    "Cloudflare.Hyperdrive",
    {
      hyperdriveId: "hd-1",
      name: "basalt-rehearsal-databaseconnection-testi5s4bzm4vov2xk5lvov2xk5l",
    },
    "DatabaseConnection",
  ),
  row("Planetscale.PostgresBranch", { database: own, name: "test-rehearsal-1234-pool" }),
  row("Planetscale.PostgresRole", { database: own, branch: "main", id: "role-1" }),
  // The shared trust root is production's too, by design, and never deleted.
  row("Cloudflare.MtlsCertificate", { id: "prod-ca" }),
  row("Command.Exec", { id: "exec-1" }),
  { path: `basalt-rehearsal/${stage}/output`, value: null },
];
const production = new Set([
  "prod-ca",
  "basalt-api-production-abcdefghijklmnop",
  "prod-hyperdrive",
  "prod-route",
  "AppWorkflows",
]);

test("a whole stage whose rows are all its own is retirable", async () => {
  assert.equal(await ownershipRefusal(whole, stage, own, production), undefined);
});

test("a whole stage whose rows name another stage's or production's objects is left, by kind", async () => {
  for (const [why, bad, reason] of [
    [
      "another stage's Worker",
      row("Cloudflare.Worker", {
        workerName: "basalt-rehearsal-api-test-rehearsal-5678-abcdefghijklmnop",
      }),
      "a Cloudflare.Worker row names an object that is not this stage's (workerName)",
    ],
    [
      "another stage's cut container name",
      row(
        "Cloudflare.Container",
        { applicationId: "app-2", applicationName: otherCut },
        "PoolContainer",
      ),
      "a Cloudflare.Container row names an object that is not this stage's (applicationName)",
    ],
    [
      "production's Worker",
      row("Cloudflare.Worker", { workerName: "basalt-api-production-abcdefghijklmnop" }),
      "a Cloudflare.Worker row records an id or name production's State records",
    ],
    [
      "a Hyperdrive config production records",
      row("Cloudflare.Hyperdrive", { hyperdriveId: "prod-hyperdrive", name: "x" }),
      "a Cloudflare.Hyperdrive row records an id or name production's State records",
    ],
    [
      "a route on production's host",
      row("Cloudflare.Worker", {
        workerName: "basalt-rehearsal-router-test-rehearsal-1234-abcdefghijklmnop",
        routes: [{ id: "route-2", pattern: "app.example.invalid/*", zoneId: "z" }],
      }),
      "a Cloudflare.Worker row routes traffic that is not this stage's (routes)",
    ],
    [
      "production's route id",
      row("Cloudflare.Worker", {
        workerName: "basalt-rehearsal-router-test-rehearsal-1234-abcdefghijklmnop",
        routes: [{ id: "prod-route", pattern: "api.rehearsal-1234.preview.example.invalid/*" }],
      }),
      "a Cloudflare.Worker row routes traffic that is not this stage's (routes)",
    ],
    [
      "a branch of another database",
      row("Planetscale.PostgresBranch", { database: "basalt", name: "main" }),
      "a Planetscale.PostgresBranch row lives outside this stage's own database",
    ],
    [
      "a hostname of another stage",
      row("Cloudflare.DNS.Record", {
        recordId: "rec-2",
        name: "api.rehearsal-5678.preview.example.invalid",
      }),
      "a Cloudflare.DNS.Record row names an object that is not this stage's (name)",
    ],
    [
      "a provider this path cannot prove",
      row("Axiom.Dataset", { name: "basalt-rehearsal-logs-test-rehearsal-1234" }),
      "a Axiom.Dataset row is of a kind this path cannot prove",
    ],
  ] as const) {
    const refusal = await ownershipRefusal([...whole, bad], stage, own, production);
    assert.equal(refusal, reason, why);
    // The reason names a kind and a key, never a value.
    assert.doesNotMatch(refusal ?? "", /5678|basalt-api|prod-|example/u, why);
  }
});
