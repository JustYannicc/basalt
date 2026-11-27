import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  alchemyPreviewStateReader,
  readProductionRecords,
  type PreviewStateEntry,
  type StateCommand,
} from "../preview/inventory.ts";
import { derivedNames } from "./retire-names.ts";
import {
  databaseRefusal,
  leftoversProof,
  ownershipRefusal,
  ownershipRefusals,
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
const row = (
  resourceType: string,
  attr: Record<string, unknown>,
  logicalId = "X",
  props?: Record<string, unknown>,
) => ({
  path: `basalt-rehearsal/${stage}/${logicalId}`,
  value: { resourceType, logicalId, instanceId: instance, ...(props && { props }), attr },
});
/** The name Alchemy's own `generateWorkflowName` gives an unnamed Workflow of this host and class. */
async function generatedWorkflow(scriptName: string, className: string) {
  const { generateWorkflowName } = (await import(
    new URL("./Cloudflare/Workflows/WorkflowName.js", import.meta.resolve("alchemy/PhysicalName"))
      .href
  )) as {
    generateWorkflowName: (script: string, name: string) => Effect.Effect<string, never, never>;
  };
  return Effect.runPromise(generateWorkflowName(scriptName, className));
}
/** A Workflow row as Alchemy records it: unnamed unless `named` sets its props' name. */
const workflow = (
  logicalId: string,
  {
    workflowName,
    scriptName,
    className = logicalId,
    named = false,
  }: { workflowName: string; scriptName: string; className?: string; named?: boolean },
) =>
  row(
    "Cloudflare.Workflow",
    {
      workflowId: `wf-${logicalId}`,
      workflowName,
      className,
      scriptName,
      accountId: "acct",
      schedules: [],
    },
    logicalId,
    named ? { workflowName, className, schedules: [] } : { className, scriptName, schedules: [] },
  );
const tokenWorker = "basalt-rehearsal-api-test-rehearsal-1234-abcdefghijklmnop";
// Cut to their limit by Alchemy, each keeps only a hash of its stage (computed once with Alchemy).
const ownCut = "basalt-rehearsal-poolcontainer-test-rehezbefejytvov2xk5lvov2xk5l";
const otherCut = "basalt-rehearsal-poolcontainer-test-rehes4wvc225vov2xk5lvov2xk5l";
const whole = [
  row("Cloudflare.Worker", {
    workerName: tokenWorker,
    routes: [
      { id: "route-1", pattern: "api.rehearsal-1234.preview.example.invalid/*", zoneId: "z" },
    ],
  }),
  // One Workflow the stack names, one Alchemy names from its host Worker and class.
  workflow("UsageWorkflow", {
    workflowName: "basalt-rehearsal-usage-test-rehearsal-1234",
    scriptName: tokenWorker,
    named: true,
  }),
  workflow("AppWorkflows", {
    workflowName: await generatedWorkflow(tokenWorker, "AppWorkflows"),
    scriptName: tokenWorker,
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

/** The name Alchemy's own `createWorkerName` gives an unnamed Worker under the rehearsal stack. */
async function workerName(id: string, stage: string, instanceId: string) {
  // Not an exported subpath: Alchemy's own file beside the PhysicalName module its exports name.
  const { createWorkerName } = (await import(
    new URL("./Cloudflare/Workers/WorkerName.js", import.meta.resolve("alchemy/PhysicalName")).href
  )) as { createWorkerName: (id: string, name: undefined) => Effect.Effect<string, never, never> };
  const { StackContext } = await import("alchemy/StackContext");
  const { Stage } = await import("alchemy/Stage");
  const { InstanceId } = await import("alchemy/InstanceId");
  return Effect.runPromise(
    createWorkerName(id, undefined).pipe(
      Effect.provideService(StackContext, { name: "basalt-rehearsal" } as never),
      Effect.provideService(Stage, stage),
      Effect.provideService(InstanceId, instanceId),
    ),
  );
}

test("an unnamed Worker cut to its 54 limit proves only as derived for its own id, instance and stage", async () => {
  const api = (name: string) => row("Cloudflare.Worker", { workerName: name }, "Api");
  const ownApi = await workerName("Api", stage, instance);
  assert.equal(ownApi.length, 54);
  assert.ok((await derivedNames("Api", instance, stage, "Cloudflare.Worker")).includes(ownApi));
  assert.equal(await ownershipRefusal([...whole, api(ownApi)], stage, own, production), undefined);
  for (const [why, name] of [
    ["derived for another stage", await workerName("Api", "test-rehearsal-9999", instance)],
    ["derived for another instance", await workerName("Api", stage, "cd".repeat(16))],
    // A Worker's name is lowercased; the same cut in its id's case is no name Alchemy gives it.
    ["the cut in mixed case", ownApi.replace("-api-", "-Api-")],
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

// Computed once with the installed Alchemy (2.0.0-beta.80): its own `createWorkerName("Api",
// undefined)` under stack basalt-rehearsal, this stage and this instance.
const pinnedApi = "basalt-rehearsal-api-test-rehed34q3xdnvov2xk5lvov2xk5l";

test("an unnamed Worker's 54-limit name is the one Alchemy gave it, pinned", async () => {
  assert.equal(pinnedApi.length, 54);
  assert.equal(await workerName("Api", stage, instance), pinnedApi);
  assert.ok((await derivedNames("Api", instance, stage, "Cloudflare.Worker")).includes(pinnedApi));
  const api = row("Cloudflare.Worker", { workerName: pinnedApi }, "Api");
  assert.equal(await ownershipRefusal([...whole, api], stage, own, production), undefined);
});

test("only a Worker row loads Alchemy's Worker name, and a failed load proves nothing", async () => {
  let loads = 0;
  const worker = async (): Promise<never> => {
    loads += 1;
    throw new Error("WorkerName.js is not there");
  };
  // No Worker of the whole stage is unnamed, so none needs the load.
  assert.equal(
    await ownershipRefusal(whole, stage, own, production, { namers: { worker } }),
    undefined,
  );
  assert.deepEqual(
    await derivedNames("PoolContainer", instance, stage, "Cloudflare.Container", { worker }),
    await derivedNames("PoolContainer", instance, stage, "Cloudflare.Container"),
  );
  assert.equal(loads, 0);
  // A Worker row whose name needs the load throws; the proof rethrows it, so no stage is taken.
  const api = row("Cloudflare.Worker", { workerName: pinnedApi }, "Api");
  await assert.rejects(
    ownershipRefusal([...whole, api], stage, own, production, { namers: { worker } }),
    /WorkerName\.js is not there/u,
  );
  assert.equal(loads, 1);
});

// Computed once with the installed Alchemy (2.0.0-beta.80): its own
// `generateWorkflowName(pinnedApi, "AppWorkflows")`, the pinned Api Worker's cut name and class.
const pinnedWorkflow = "basalt-rehearsal-api-test-rehed34q3xdnvov2xk5lvov2xk5l-1015f0a7";
const pinnedHost = row("Cloudflare.Worker", { workerName: pinnedApi, workerId: "w-api" }, "Api");
const appWorkflows = (over: { workflowName?: string; scriptName?: string; className?: string }) =>
  workflow("AppWorkflows", { workflowName: pinnedWorkflow, scriptName: pinnedApi, ...over });

test("an unnamed Workflow proves by Alchemy's name over a proven stage Worker's cut name", async () => {
  assert.equal(await generatedWorkflow(pinnedApi, "AppWorkflows"), pinnedWorkflow);
  // The host's 54-char cut, then 8 hex of the sha256 of host and class.
  assert.match(pinnedWorkflow, new RegExp(`^${pinnedApi}-[0-9a-f]{8}$`, "u"));
  const rows = [...whole, pinnedHost, appWorkflows({})];
  assert.equal(await ownershipRefusal(rows, stage, own, production), undefined);
});

test("an unnamed Workflow whose host or class is not its own is refused", async () => {
  const hostless =
    "a Cloudflare.Workflow row is hosted by no Worker this stage proves (scriptName)";
  const misnamed =
    "a Cloudflare.Workflow row is not named as Alchemy names it from its host and class (workflowName)";
  const otherStageHost = {
    path: `basalt-rehearsal/test-rehearsal-9999/Api`,
    value: pinnedHost.value,
  };
  for (const [why, rows, line] of [
    ["its host Worker is not in the stage's State", [appWorkflows({})], hostless],
    ["its host Worker is another stage's row", [otherStageHost, appWorkflows({})], hostless],
    [
      // The same cut name on another row's id is no name Alchemy gives that row.
      "its host Worker does not prove",
      [row("Cloudflare.Worker", { workerName: pinnedApi }, "Router"), appWorkflows({})],
      hostless,
    ],
    ["another class", [pinnedHost, appWorkflows({ className: "BillingWorkflows" })], misnamed],
    [
      "another host's name, of a Worker that proves",
      [
        pinnedHost,
        row("Cloudflare.Worker", { workerName: tokenWorker }, "Other"),
        appWorkflows({ scriptName: tokenWorker }),
      ],
      misnamed,
    ],
    [
      "its props' class is not its own",
      [
        pinnedHost,
        {
          ...appWorkflows({}),
          value: { ...appWorkflows({}).value, props: { className: "BillingWorkflows" } },
        },
      ],
      misnamed,
    ],
  ] as const) {
    const refusals = await ownershipRefusals([...whole, ...rows], stage, own, production);
    const refused = refusals.find(({ detail }) => detail.type === "Cloudflare.Workflow");
    assert.equal(refused?.line, line, why);
    assert.equal(refused?.detail.path, `basalt-rehearsal/${stage}/AppWorkflows`, why);
    assert.doesNotMatch(refused?.line ?? "", /rehe|1015/u, why);
  }
});

test("a Workflow whose name needs Alchemy's loader throws when it fails", async () => {
  let loads = 0;
  const failing = async (): Promise<never> => {
    loads += 1;
    throw new Error("WorkflowName.js is not there");
  };
  await assert.rejects(
    ownershipRefusal([...whole, pinnedHost, appWorkflows({})], stage, own, production, {
      namers: { workflow: failing },
    }),
    /WorkflowName\.js is not there/u,
  );
  assert.ok(loads >= 1);
  // A stage with no unnamed Workflow never loads it.
  loads = 0;
  const named = whole.filter(({ path }) => !path.endsWith("/AppWorkflows"));
  assert.equal(
    await ownershipRefusal(named, stage, own, production, { namers: { workflow: failing } }),
    undefined,
  );
  assert.equal(loads, 0);
});

test("a Workflow the stack names keeps the token rule, its host proving its script name", async () => {
  const named = (workflowName: string) =>
    workflow("UsageWorkflow", { workflowName, scriptName: pinnedApi, named: true });
  // Its host is the pinned Api Worker, whose cut name proves by that host.
  assert.equal(
    await ownershipRefusal(
      [...whole, pinnedHost, named("basalt-rehearsal-usage-test-rehearsal-1234")],
      stage,
      own,
      production,
    ),
    undefined,
  );
  assert.equal(
    (
      await ownershipRefusal(
        [...whole, pinnedHost, named("basalt-rehearsal-usage-test-rehearsal-5678")],
        stage,
        own,
        production,
      )
    )?.line,
    "a Cloudflare.Workflow row names an object that is not this stage's (workflowName)",
  );
});

/** `createPhysicalName` for this stage and instance, at a limit and case some provider uses. */
async function physical(id: string, maxLength: number, lowercase: boolean) {
  const { createPhysicalName } = await import("alchemy/PhysicalName");
  const { StackContext } = await import("alchemy/StackContext");
  const { Stage } = await import("alchemy/Stage");
  return Effect.runPromise(
    createPhysicalName({ id, instanceId: instance, maxLength, lowercase }).pipe(
      Effect.provideService(StackContext, { name: "basalt-rehearsal" } as never),
      Effect.provideService(Stage, stage),
    ) as Effect.Effect<string>,
  );
}

test("each Cloudflare kind proves only at its own provider's limit and case", async () => {
  const bucketId = "RehearsalArtifactUploadsBucket";
  // R2: cut to 63, then lowercased; a 64 cut is no name its provider gives.
  const bucket = await physical(bucketId, 63, false).then((name) => name.toLowerCase());
  assert.equal(bucket.length, 63);
  // Hyperdrive and containers: 64, lowercase; a 63 cut is none either.
  const cases = [
    ["Cloudflare.R2.Bucket", bucketId, "bucketName", bucket, await physical(bucketId, 64, true)],
    [
      "Cloudflare.Hyperdrive",
      "DatabaseConnection",
      "name",
      await physical("DatabaseConnection", 64, true),
      await physical("DatabaseConnection", 63, true),
    ],
    [
      "Cloudflare.Container",
      "PoolContainer",
      "applicationName",
      ownCut,
      await physical("PoolContainer", 63, true),
    ],
    // Workers: their own 54 limit, lowercased; a 64 cut is none. Long enough an id to cut at both.
    [
      "Cloudflare.Worker",
      "ApiGatewayWorker",
      "workerName",
      await workerName("ApiGatewayWorker", stage, instance),
      await physical("ApiGatewayWorker", 64, true),
    ],
  ] as const;
  for (const [type, id, key, ownName, otherRule] of cases) {
    assert.notEqual(ownName, otherRule, type);
    // Both cut, so neither carries the stage whole: only the derivation can prove them.
    assert.ok(!ownName.includes(stage) && !otherRule.includes(stage), type);
    assert.equal(
      await ownershipRefusal([...whole, row(type, { [key]: ownName }, id)], stage, own, production),
      undefined,
      type,
    );
    assert.equal(
      (
        await ownershipRefusal(
          [...whole, row(type, { [key]: otherRule }, id)],
          stage,
          own,
          production,
        )
      )?.line,
      `a ${type} row names an object that is not this stage's (${key})`,
      type,
    );
  }
  // A DNS record is always named by the stack: under the stage's host it proves, and a name
  // derived from its id, which no DNS provider gives, does not.
  const record = (name: string) =>
    row("Cloudflare.DNS.Record", { recordId: "rec-9", name }, "ApiOriginWildcardRecord");
  assert.equal(
    await ownershipRefusal(
      [...whole, record("*.rehearsal-1234.preview.example.invalid")],
      stage,
      own,
      production,
    ),
    undefined,
  );
  assert.equal(
    (
      await ownershipRefusal(
        [...whole, record(await physical("ApiOriginWildcardRecord", 64, true))],
        stage,
        own,
        production,
      )
    )?.line,
    "a Cloudflare.DNS.Record row names an object that is not this stage's (name)",
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
    "  stage 2 left: 1 row refused (Cloudflare.Worker)",
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
  assert.ok(lines.every((line) => !/test-rehearsal-\d|state read/u.test(line)));

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

test("leftovers lists every refusing row of a stage privately, and one public line with the count", async () => {
  const badWorkflow = appWorkflows({ className: "BillingWorkflows" });
  const badBranch = row(
    "Planetscale.PostgresBranch",
    { database: "basalt", name: "main" },
    "Branch",
  );
  const rows = [...whole, foreignWorker, pinnedHost, badWorkflow, badBranch];
  const lines: string[] = [];
  let written: readonly RetireRefusal[] = [];
  const proof = await leftoversProof([{ ordinal: 1, stage }], {
    ...memoryReads({ [stage]: rows }),
    phases: {},
    log: (line) => lines.push(line),
    writeRefusals: async (refusals) => {
      written = [...refusals];
    },
    keepPrivate: async () => assert.fail("nothing to keep"),
  });
  assert.deepEqual(proof, [
    "  stage 1 left: 3 rows refused (Cloudflare.Worker, Cloudflare.Workflow, Planetscale.PostgresBranch)",
  ]);
  assert.deepEqual(lines, proof);
  assert.deepEqual(
    written.map(({ ordinal, path, type, key, value }) => ({ ordinal, path, type, key, value })),
    [
      {
        ordinal: 1,
        path: foreignWorker.path,
        type: "Cloudflare.Worker",
        key: "workerName",
        value: "basalt-rehearsal-api-test-rehearsal-5678-abcdefghijklmnop",
      },
      {
        ordinal: 1,
        path: badWorkflow.path,
        type: "Cloudflare.Workflow",
        key: "workflowName",
        value: pinnedWorkflow,
      },
      {
        ordinal: 1,
        path: badBranch.path,
        type: "Planetscale.PostgresBranch",
        key: "database",
        value: "basalt",
      },
    ],
  );
  // The public line carries no value.
  assert.doesNotMatch(lines.join("\n"), /5678|rehe|1015|basalt"/u);

  // A retire stops the same stage at its first refusal, and takes nothing of it.
  const refusals: RetireRefusal[] = [];
  const retireLines: string[] = [];
  const result = await proveStages([{ ordinal: 1, stage }], {
    ...memoryReads({ [stage]: rows }),
    refusals,
    phases: {},
    log: (line) => retireLines.push(line),
    take: async () => assert.fail("a refused stage is never taken"),
  });
  assert.deepEqual(result, { taken: undefined });
  assert.equal(refusals.length, 1);
  assert.deepEqual(retireLines, [
    "  stage 1 left: a Cloudflare.Worker row names an object that is not this stage's (workerName); nothing of it deleted",
  ]);
});

test("a database row refused by both proofs is listed once", async () => {
  const lines: string[] = [];
  const refusals: RetireRefusal[] = [];
  await proveStages([{ ordinal: 1, stage }], {
    ...memoryReads({ [stage]: [...whole, database("basalt-preview-rehearsal-5678")] }),
    refusals,
    phases: {},
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ["  stage 1 left: 1 row refused (Planetscale.PostgresDatabase)"]);
  assert.equal(refusals.length, 1);
});
