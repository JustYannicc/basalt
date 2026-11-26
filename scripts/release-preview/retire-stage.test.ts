import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alchemyPreviewStateReader,
  readProductionRecords,
  type PreviewStateEntry,
  type StateCommand,
} from "../preview/inventory.ts";
import {
  databaseRefusal,
  leftoversProof,
  ownershipRefusal,
  proveStages,
  retirePlan,
  retireSubject,
  type RetireRefusal,
} from "./retire-stage.ts";

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
    assert.equal(refusal?.line, reason, why);
    // The reason names a kind and a key, never a value; the row that refused is in the detail.
    assert.doesNotMatch(refusal?.line ?? "", /5678|basalt-api|prod-|example/u, why);
    assert.equal(refusal?.detail.path, bad.path, why);
  }
});

test("an unnamed Worker cut to its 54 limit proves only as derived for its own id, instance and stage", async () => {
  // Alchemy's `createWorkerName` for `Api`, lowercased (computed once with Alchemy).
  const api = (workerName: string) => row("Cloudflare.Worker", { workerName }, "Api");
  const ownApi = "basalt-rehearsal-api-test-rehed34q3xdnvov2xk5lvov2xk5l";
  assert.equal(await ownershipRefusal([...whole, api(ownApi)], stage, own, production), undefined);
  for (const [why, name] of [
    ["derived for another stage", "basalt-rehearsal-api-test-rehey4lomo57vov2xk5lvov2xk5l"],
    ["derived for another instance", "basalt-rehearsal-api-test-rehew7sresduzxg43tonzxg43ton"],
    // A Worker's name is lowercased; the same cut in its id's case is no name Alchemy gives it.
    ["the cut in mixed case", "basalt-rehearsal-Api-test-rehed34q3xdnvov2xk5lvov2xk5l"],
  ] as const)
    assert.equal(
      (await ownershipRefusal([...whole, api(name)], stage, own, production))?.line,
      "a Cloudflare.Worker row names an object that is not this stage's (workerName)",
      why,
    );
  // The same cut on another row's id is refused too: the hash covers the id.
  assert.ok(
    await ownershipRefusal(
      [...whole, row("Cloudflare.Worker", { workerName: ownApi }, "Router")],
      stage,
      own,
      production,
    ),
  );
});

// A database-only stage as its stack records it: the stack's output row, then its database.
const outputRow = {
  path: `basalt-preview-database/${stage}/output`,
  value: { databaseName: own, branch: "main", origin: "https://db.example.invalid" },
};
const databaseOnly = [outputRow, database(own)];

test("a database-only stage proves, its stack's output row included", async () => {
  const productionDatabases = [{ id: "prod-id", name: "basalt" }];
  assert.equal(databaseRefusal(databaseOnly, own, productionDatabases), undefined);
  assert.equal(await ownershipRefusal(databaseOnly, stage, own, production), undefined);
});

test("an output row is skipped whatever it holds, but a row with no type is still refused", async () => {
  // An output that reads like a foreign Postgres database or production's Worker proves nothing
  // either way: a destroy sends no request for it.
  for (const value of [
    { resourceType: "Planetscale.PostgresDatabase", attr: { id: "prod-id", name: "basalt" } },
    {
      resourceType: "Cloudflare.Worker",
      attr: { workerName: "basalt-api-production-abcdefghijklmnop" },
    },
    { resourceType: "Axiom.Dataset", attr: {} },
  ]) {
    const rows = [...whole, { path: `basalt-rehearsal/${stage}/output`, value }];
    assert.equal(databaseRefusal(rows, own, [{ id: "prod-id", name: "basalt" }]), undefined);
    assert.equal(await ownershipRefusal(rows, stage, own, production), undefined);
  }
  const untyped = { path: `basalt-rehearsal/${stage}/Stray`, value: { attr: { name: "x" } } };
  const refusal = await ownershipRefusal([...whole, untyped], stage, own, production);
  assert.equal(refusal?.line, "a row with no type is of a kind this path cannot prove");
  assert.doesNotMatch(refusal?.line ?? "", / {2}/u);
  assert.deepEqual(refusal?.detail, { path: untyped.path, type: null, key: null, value: null });
});

test("a refusal's private detail names the row, its type, key and value; its line none of them", async () => {
  const foreign = "basalt-rehearsal-api-test-rehearsal-5678-abcdefghijklmnop";
  const bad = row("Cloudflare.Worker", { workerName: foreign }, "Api");
  const refusal = await ownershipRefusal([...whole, bad], stage, own, production);
  assert.deepEqual(refusal?.detail, {
    path: bad.path,
    type: "Cloudflare.Worker",
    key: "workerName",
    value: foreign,
  });
  assert.ok(!refusal?.line.includes(foreign));
  assert.doesNotMatch(refusal?.line ?? "", /5678|Api\b/u);
  const other = database("basalt-preview-rehearsal-5678");
  const refused = databaseRefusal([other], own, []);
  assert.deepEqual(refused?.detail, {
    path: other.path,
    type: "Planetscale.PostgresDatabase",
    key: "name",
    value: "basalt-preview-rehearsal-5678",
  });
  assert.ok(!refused?.line.includes("5678"));
});

test("leftovers' proof pass reads and proves every stage, and plans, deletes and writes nothing", async () => {
  const lane = "test-rehearsal-1";
  const verbs: string[] = [];
  // Two four-digit stages: one database-only with its output row, one recording another stage's
  // Worker. Production's State records its own database.
  const stored: Record<string, Record<string, unknown>> = {
    "basalt-preview-database/test-rehearsal-1234": {
      [outputRow.path]: outputRow.value,
      [database(own).path]: database(own).value,
    },
    "basalt-rehearsal/test-rehearsal-5678": {
      "basalt-rehearsal/test-rehearsal-5678/Api": {
        resourceType: "Cloudflare.Worker",
        logicalId: "Api",
        instanceId: instance,
        attr: { workerName: "basalt-rehearsal-api-test-rehearsal-1234-abcdefghijklmnop" },
      },
    },
    "basalt/production": {
      "basalt/production/Database": {
        resourceType: "Planetscale.PostgresDatabase",
        attr: { id: "prod-id", name: "basalt" },
      },
    },
  };
  const command: StateCommand = (args) => {
    const verb = args[args.indexOf("state") + 1]!;
    const at = args[args.indexOf("state") + 2]!;
    verbs.push(verb);
    if (verb === "list" && at === "--config")
      return { status: 0, stdout: "basalt/\nbasalt-rehearsal/\nbasalt-preview-database/\n" };
    const [stack, stageName] = at.split("/");
    if (verb === "list" && !stageName)
      return {
        status: 0,
        stdout: Object.keys(stored)
          .filter((key) => key.startsWith(`${stack}/`))
          .map((key) => `${key}/`)
          .join("\n"),
      };
    const rows = stored[at] ?? {};
    if (verb === "list") return { status: 0, stdout: Object.keys(rows).join("\n") };
    // The State CLI prints one row's record bare, and several as a map by path.
    const values = Object.values(rows);
    if (verb === "read")
      return { status: 0, stdout: JSON.stringify(values.length === 1 ? values[0] : rows) };
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const reads = (name: string) => ({
    stage: name,
    database: `basalt-preview-${name.slice("test-".length)}`,
    read: () => alchemyPreviewStateReader({ command, environment: {} }).read(name),
  });
  const lines: string[] = [];
  const refusals: RetireRefusal[] = [];
  const phases: Record<string, number> = {};
  let productionReads = 0;
  const { taken } = await proveStages(
    [
      { ordinal: 1, stage: "test-rehearsal-1234" },
      { ordinal: 2, stage: "test-rehearsal-5678" },
      { ordinal: 3, stage: "test-rehearsal-9012", unreadable: "private" },
    ],
    {
      target: reads,
      production: () => {
        productionReads += 1;
        return readProductionRecords(lane, { command, environment: {} });
      },
      refusals,
      phases,
      log: (line) => lines.push(line),
    },
  );
  assert.equal(taken, undefined);
  assert.deepEqual(lines, [
    "  stage 1: retirable",
    "  stage 2 left: a Cloudflare.Worker row names an object that is not this stage's (workerName)",
    "  stage 3 left: its State could not be read",
  ]);
  assert.equal(productionReads, 1);
  assert.deepEqual(
    refusals.map(({ ordinal, stage: name, key, value }) => ({ ordinal, name, key, value })),
    [
      {
        ordinal: 2,
        name: "test-rehearsal-5678",
        key: "workerName",
        value: "basalt-rehearsal-api-test-rehearsal-1234-abcdefghijklmnop",
      },
    ],
  );
  assert.deepEqual(Object.keys(phases).sort(), [
    "production records",
    "stage 1 proof",
    "stage 1 read",
    "stage 2 proof",
    "stage 2 read",
  ]);
  // Only lists and reads reached the store; nothing was planned or destroyed.
  assert.ok(verbs.length > 0 && verbs.every((verb) => verb === "list" || verb === "read"));
});

/** Stages read from memory: `rows` by stage, with production recording `production` above. */
const memoryReads = (rows: Record<string, PreviewStateEntry[]>) => ({
  target: (name: string) => ({
    stage: name,
    database: `basalt-preview-${name.slice("test-".length)}`,
    read: async () => ({ "basalt-rehearsal": rows[name] ?? [] }),
  }),
  production: async () => ({
    databases: [{ id: "prod-id", name: "basalt" }],
    identities: production,
  }),
});
const foreignWorker = row("Cloudflare.Worker", {
  workerName: "basalt-rehearsal-api-test-rehearsal-5678-abcdefghijklmnop",
});

test("a retire takes the first stage that proves, after skipping the ones refused", async () => {
  const taken: string[] = [];
  const refusals: RetireRefusal[] = [];
  const lines: string[] = [];
  const result = await proveStages(
    [
      { ordinal: 1, stage: "test-rehearsal-9999" },
      { ordinal: 2, stage: "test-rehearsal-8888", unreadable: "private" },
      { ordinal: 3, stage },
      { ordinal: 4, stage: "test-rehearsal-7777" },
    ],
    {
      ...memoryReads({ "test-rehearsal-9999": [foreignWorker], [stage]: whole }),
      refusals,
      phases: {},
      log: (line) => lines.push(line),
      take: async (name, stacks) => {
        taken.push(name);
        assert.deepEqual(stacks, { "basalt-rehearsal": whole });
      },
    },
  );
  assert.deepEqual(result, { taken: 3 });
  // Only the first stage that proves is taken; the one after it is never read.
  assert.deepEqual(taken, [stage]);
  assert.deepEqual(
    refusals.map(({ ordinal, key }) => ({ ordinal, key })),
    [{ ordinal: 1, key: "workerName" }],
  );
  assert.deepEqual(lines, [
    "  stage 1 left: a Cloudflare.Worker row names an object that is not this stage's (workerName); nothing of it deleted",
    "  stage 2 left: its State could not be read",
    "Retiring stage 3.",
  ]);
});

test("refusals found before a failed take are kept", async () => {
  const refusals: RetireRefusal[] = [];
  await assert.rejects(
    proveStages(
      [
        { ordinal: 1, stage: "test-rehearsal-9999" },
        { ordinal: 2, stage },
      ],
      {
        ...memoryReads({ "test-rehearsal-9999": [foreignWorker], [stage]: whole }),
        refusals,
        phases: {},
        log: () => {},
        take: async () => {
          throw new Error("the destroy failed");
        },
      },
    ),
    /the destroy failed/u,
  );
  assert.deepEqual(
    refusals.map(({ ordinal, stage: name }) => ({ ordinal, name })),
    [{ ordinal: 1, name: "test-rehearsal-9999" }],
  );
});

test("leftovers' proof pass failing leaves the mode's result, marked unreadable, refusals written", async () => {
  const lines: string[] = [];
  const kept: string[] = [];
  let written: readonly RetireRefusal[] | undefined;
  const reads = memoryReads({ "test-rehearsal-9999": [foreignWorker], [stage]: whole });
  const proof = await leftoversProof(
    [
      { ordinal: 1, stage: "test-rehearsal-9999" },
      { ordinal: 2, stage },
    ],
    {
      ...reads,
      target: (name) =>
        name === stage
          ? {
              ...reads.target(name),
              read: () => Promise.reject(new Error("state read for test-rehearsal-1234 refused")),
            }
          : reads.target(name),
      phases: {},
      log: (line) => lines.push(line),
      writeRefusals: async (refusals) => {
        written = [...refusals];
      },
      keepPrivate: async (text) => {
        kept.push(text);
      },
    },
  );
  assert.equal(proof, "unreadable");
  assert.deepEqual(
    written?.map(({ ordinal }) => ordinal),
    [1],
  );
  // The error's text reaches only the private outputs; the public lines say only that it failed.
  assert.match(kept.join("\n"), /state read for test-rehearsal-1234 refused/u);
  assert.equal(lines.at(-1), "The retire proof could not be read; the table above stands");
  assert.ok(lines.every((line) => !/test-rehearsal-\d|refused/u.test(line)));

  // A pass that reads and proves returns its public lines, and writes its refusals too.
  written = undefined;
  const lines2: string[] = [];
  const passed = await leftoversProof([{ ordinal: 1, stage }], {
    ...reads,
    phases: {},
    log: (line) => lines2.push(line),
    writeRefusals: async (refusals) => {
      written = [...refusals];
    },
    keepPrivate: async () => assert.fail("nothing to keep"),
  });
  assert.deepEqual(passed, ["  stage 1: retirable"]);
  assert.deepEqual(lines2, passed);
  assert.deepEqual(written, []);
});
