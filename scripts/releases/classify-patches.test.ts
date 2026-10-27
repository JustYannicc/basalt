import assert from "node:assert/strict";
import test from "node:test";
import { classifySnapshots } from "./classify.ts";
import { pins, sha } from "./fixtures.test-helpers.ts";
import { sha256PatchContent } from "./patch-registry.ts";
import type { ClassificationReport, PatchManifestV3 } from "./types.ts";

const file = "0011-hosted-connectors.patch";

/** Classifies one registered carry whose content changes from `before` to `after`. */
function classifyCarry(
  before: string | Uint8Array | undefined,
  after: string | Uint8Array | undefined,
  sensitive = { database: false, workflow: false },
): ClassificationReport {
  const manifest = (content: string | Uint8Array | undefined): PatchManifestV3 => ({
    format_version: 3,
    repository: "UsefulSoftwareCo/executor",
    patches: content === undefined ? [] : [{
      identity: "basalt-hosted-connectors",
      file,
      content_sha256: sha256PatchContent(content),
      kind: "overlay",
      upstream_pull_request: null,
      database_sensitive: sensitive.database,
      workflow_sensitive: sensitive.workflow,
    }],
  });
  return classifySnapshots({
    baseGitCommit: sha("1"),
    candidateGitCommit: sha("2"),
    basePins: pins(),
    candidatePins: pins(),
    basePatchManifest: manifest(before),
    candidatePatchManifest: manifest(after),
    localChangedPaths: [`patches/${file}`],
    patchContents: { [file]: { base: before, candidate: after } },
  });
}

const connectorSection = `diff --git a/apps/hosted/server/src/implementation/first-party-oauth.ts b/apps/hosted/server/src/implementation/first-party-oauth.ts
--- a/apps/hosted/server/src/implementation/first-party-oauth.ts
+++ b/apps/hosted/server/src/implementation/first-party-oauth.ts
@@ -114,6 +114,8 @@
   "search:confluence",
 ];

+/** The scopes the hosted Zendesk client may request and keep on a grant. */
+const zendeskScopes = ["tickets:read", "tickets:write", "users:read"];
 export const firstPartyClients = [
   atlassian,
   github,
`;

// The real carry change behind the User-Agent fix: a header added inside the outbound Worker.
const outboundSection = `diff --git a/apps/hosted/cloud/src/infrastructure/app-outbound.ts b/apps/hosted/cloud/src/infrastructure/app-outbound.ts
--- a/apps/hosted/cloud/src/infrastructure/app-outbound.ts
+++ b/apps/hosted/cloud/src/infrastructure/app-outbound.ts
@@ -22,7 +22,14 @@
     compatibility: { date: "2026-09-08", flags: ["global_fetch_strictly_public"] },
     // This private service has no application bindings or credentials.
     script: \`export default {
-      fetch(request) { return fetch(request); }
+      fetch(request) {
+        if (!request.headers.has("User-Agent")) {
+          const headers = new Headers(request.headers);
+          headers.set("User-Agent", "Executor");
+          request = new Request(request, { headers });
+        }
+        return fetch(request);
+      }
     };\`,
   });
 });
`;

/** A modification section for `path` replacing `removed` lines with `added` lines. */
function section(path: string, context: string[], removed: string[], added: string[]): string {
  const oldCount = context.length + removed.length;
  const newCount = context.length + added.length;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -40,${oldCount} +40,${newCount} @@`,
    ...context.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function assertClear(report: ClassificationReport) {
  assert.equal(report.databaseChanged, false, JSON.stringify(report.evidence.database));
  assert.equal(report.workflowChanged, false, JSON.stringify(report.evidence.workflow));
}

test("a pure HTTP header change in a runtime carry changes neither database nor Workflow", () => {
  const report = classifyCarry(connectorSection, connectorSection + outboundSection);
  assertClear(report);
  assert.deepEqual(report.evidence.database.sources, []);
  assert.deepEqual(report.evidence.workflow.sources, []);
});

test("index-line churn and unchanged sections do not count as a change", () => {
  const indexed = connectorSection.replace(/^(diff --git .*)\n/, "$1\nindex 1111111..2222222 100644\n");
  assertClear(classifyCarry(connectorSection + outboundSection, indexed + outboundSection));
});

test("a traditional unified section is parsed like git apply reads it", () => {
  const traditional = outboundSection.replace(/^diff --git .*\n/, "");
  assertClear(classifyCarry(connectorSection, connectorSection + traditional));
});

test("removing a whole carry is classified by everything it carried", () => {
  assertClear(classifyCarry(connectorSection + outboundSection, undefined));
  const migration = section("apps/hosted/cloud/src/migrate.ts", ["yield* migrateProduct;"], [], ["yield* migrateConnectors;"]);
  assert.equal(classifyCarry(connectorSection + migration, undefined).databaseChanged, true);
});

test("schema, migration and DDL changes are database-changing", () => {
  const cases = [
    // A migration module, by path.
    section("apps/hosted/server/src/implementation/migrations.ts", ["  migrateGroups,"], [], ["  migrateConnectorAccounts,"]),
    // A fumadb table definition.
    section("packages/sdk/src/implementation/storage-schema.ts", ["  accounts: table(\"executor_accounts\", {"], [], ["    region: column(\"region\", Schema.String),"]),
    // DDL in a module whose path names no database.
    section("apps/hosted/server/src/implementation/connector-access.ts", ["  const sql = yield* SqlClient.SqlClient;"], [], ["  yield* sql`alter table hosted_app_access add column note text`;"]),
    // A column added deep inside an existing create table statement.
    section("apps/hosted/server/src/implementation/connector-access.ts", ["    creator_id text references \"user\"(id) on delete set null,"], [], ["    site text not null,"]),
    // Raw SQL migration files.
    section("packages/fumadb-effect/migrations/0002_sites.sql", ["create table sites ();"], [], ["create index sites_host on sites (host);"]),
  ];
  for (const fixture of cases) {
    const report = classifyCarry(connectorSection, connectorSection + fixture);
    assert.equal(report.databaseChanged, true, fixture);
    assert.equal(report.evidence.database.sources[0]?.state, "changed", fixture);
    assert.equal(report.workflowChanged, false, fixture);
  }
});

test("database role and grant changes are database-changing", () => {
  const cases = [
    section("apps/hosted/cloud/src/infrastructure/runtime-access.ts", ["  await client.query(\"begin\");"], [], ["  await client.query(\"grant select, insert on all tables in schema public to executor_runtime\");"]),
    section("apps/hosted/cloud/src/infrastructure/runtime-access.ts", ["  await client.query(\"begin\");"], [], ["  await client.query(\"grant pg_read_all_data to executor_runtime\");"]),
    section("apps/hosted/cloud/src/infrastructure/stack.ts", ["  const role = yield* Planetscale.PostgresRole(\"RuntimeRole\", {"], ["    inheritedRoles: [\"pg_read_all_data\"],"], ["    inheritedRoles: [\"pg_read_all_data\", \"pg_write_all_data\"],"]),
    section("apps/hosted/cloud/src/infrastructure/stack.ts", ["const url = new URL(origin);"], ["url.searchParams.set(\"options\", \"-c role=postgres\");"], ["url.searchParams.set(\"options\", \"-c role=executor_admin\");"]),
  ];
  for (const fixture of cases) {
    const report = classifyCarry(connectorSection, connectorSection + fixture);
    assert.equal(report.databaseChanged, true, fixture);
    assert.equal(report.evidence.database.sources[0]?.state, "changed", fixture);
  }
});

test("Workflow definition, binding and step identity changes are Workflow-changing", () => {
  const cases = [
    section("apps/hosted/cloud/src/infrastructure/workflows.ts", ["    const executor = yield* Effect.flatten(HostedExecutor);"], [], ["    const region = yield* Region;"]),
    section("apps/hosted/cloud/src/mcp-server.ts", ["        // Apps started from MCP tools run on the API-owned workflow."], ["        AppWorkflows: Cloudflare.Workflow(\"AppWorkflows\", {"], ["        AppRuns: Cloudflare.Workflow(\"AppRuns\", {"]),
    section("apps/hosted/cloud/src/infrastructure/driver.ts", ["      do: (name, options, work) =>"], ["          step.do({ name,"], ["          step.do({ name: `v2:${name}`,"]),
  ];
  for (const fixture of cases) {
    const report = classifyCarry(connectorSection, connectorSection + fixture);
    assert.equal(report.workflowChanged, true, fixture);
    assert.equal(report.evidence.workflow.sources[0]?.state, "changed", fixture);
    assert.equal(report.databaseChanged, false, fixture);
  }
});

// The EU carry edits a dependency patch; its inner `diff --git` headers are carry context lines.
function nestedCarry(innerPath: string, removed: string[], added: string[], header = true): string {
  const inner = [
    ...header ? [
      ` diff --git a/${innerPath} b/${innerPath}`,
      " index a9ec2cb..edf8dcb 100644",
      ` --- a/${innerPath}`,
      ` +++ b/${innerPath}`,
    ] : [],
    " @@ -8,4 +8,5 @@ import * as Effect from \"effect/Effect\";",
    "  // Type the import before chaining to avoid expanding the full module namespace",
    ...removed.map((line) => `-+${line}`),
    ...added.map((line) => `++${line}`),
  ];
  const oldCount = inner.filter((line) => !line.startsWith("+")).length;
  const newCount = inner.filter((line) => !line.startsWith("-")).length;
  return [
    "diff --git a/patches/alchemy@2.0.0-beta.80.patch b/patches/alchemy@2.0.0-beta.80.patch",
    "--- a/patches/alchemy@2.0.0-beta.80.patch",
    "+++ b/patches/alchemy@2.0.0-beta.80.patch",
    `@@ -456,${oldCount} +2848,${newCount} @@ index 1d27a07..553a8c5 100644`,
    ...inner,
    "",
  ].join("\n");
}

test("a nested alchemy patch is judged by its own inner file paths", () => {
  const workflow = classifyCarry(
    nestedCarry("lib/Cloudflare/Workflows/Workflow.js", ["export const scoped = false;"], []),
    nestedCarry("lib/Cloudflare/Workflows/Workflow.js", ["export const scoped = false;"], ["export const scoped = true;"]),
  );
  assert.equal(workflow.workflowChanged, true);
  assert.match(workflow.evidence.workflow.sources[0]?.reason ?? "", /lib\/Cloudflare\/Workflows\/Workflow\.js/);
  assert.equal(workflow.databaseChanged, false);

  const workers = classifyCarry(
    nestedCarry("lib/Cloudflare/Workers/cloudflare_workers.js", ["const scoped = new Map();"], []),
    nestedCarry("lib/Cloudflare/Workers/cloudflare_workers.js", ["const scoped = new Map();"], ["const cache = new Map();"]),
  );
  assertClear(workers);
});

test("a nested patch edit with no visible inner file header stays unknown", () => {
  const report = classifyCarry(
    nestedCarry("lib/Cloudflare/Workers/cloudflare_workers.js", ["const scoped = new Map();"], [], false),
    nestedCarry("lib/Cloudflare/Workers/cloudflare_workers.js", ["const scoped = new Map();"], ["const cache = new Map();"], false),
  );
  assert.equal(report.databaseChanged, true);
  assert.equal(report.workflowChanged, true);
  assert.equal(report.evidence.database.sources[0]?.state, "unknown");
  assert.match(report.evidence.workflow.sources[0]?.reason ?? "", /outside a visible file header/);
});

test("unparseable, binary, non-UTF-8 and renamed changes stay unknown", () => {
  const binary = [
    "diff --git a/apps/hosted/cloud/src/infrastructure/outbound.wasm b/apps/hosted/cloud/src/infrastructure/outbound.wasm",
    "index 1111111..2222222 100644",
    "GIT binary patch",
    "literal 4",
    "LcmZQzWMT#Y01f~L",
    "",
    "",
  ].join("\n");
  const rename = [
    "diff --git a/apps/hosted/cloud/src/infrastructure/app-outbound.ts b/apps/hosted/cloud/src/infrastructure/outbound.ts",
    "similarity index 100%",
    "rename from apps/hosted/cloud/src/infrastructure/app-outbound.ts",
    "rename to apps/hosted/cloud/src/infrastructure/outbound.ts",
    "",
  ].join("\n");
  const truncated = outboundSection.split("\n").slice(0, 8).join("\n");
  const notUtf8 = new Uint8Array([...Buffer.from(connectorSection), 0xff, 0xfe, 0x0a]);
  for (const after of [connectorSection + binary, connectorSection + rename, connectorSection + truncated, "+headers.set(\"User-Agent\")\n", notUtf8]) {
    const report = classifyCarry(connectorSection, after);
    assert.equal(report.databaseChanged, true);
    assert.equal(report.workflowChanged, true);
    assert.equal(report.evidence.database.sources[0]?.state, "unknown");
    assert.equal(report.evidence.workflow.sources[0]?.state, "unknown");
  }
});

test("visible documentation and test changes inside a carry cannot change database or Workflow", () => {
  const docs = section("notes/storage.md", ["## Migrations"], [], ["Workflows never run a migration."]);
  const tests = section("e2e/cloud/workflows.test.ts", ["test(\"runs\", async () => {"], [], ["  await sql`create table probe (id text)`;"]);
  assertClear(classifyCarry(connectorSection, connectorSection + docs + tests));
});

test("an opaque change cannot hide behind a binary or a renamed documentation file", () => {
  const image = [
    "diff --git a/apps/hosted/cloud/public/logo.png b/apps/hosted/cloud/public/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/apps/hosted/cloud/public/logo.png and b/apps/hosted/cloud/public/logo.png differ",
    "",
  ].join("\n");
  assert.equal(classifyCarry(connectorSection, connectorSection + image).evidence.database.sources[0]?.state, "unknown");

  // A binary section ends at its payload; the section after it is still classified.
  const binaryThenDdl = [
    "diff --git a/docs/diagram.png b/docs/diagram.png",
    "new file mode 100644",
    "index 0000000..2222222",
    "GIT binary patch",
    "literal 4",
    "LcmZQzWMT#Y01f~L",
    "",
    "literal 0",
    "HcmV?d00001",
    "",
    "--- a/apps/hosted/cloud/src/infrastructure/startup.ts",
    "+++ b/apps/hosted/cloud/src/infrastructure/startup.ts",
    "@@ -1,1 +1,2 @@",
    " const sql = yield* SqlClient.SqlClient;",
    "+yield* sql`create table hidden (id text)`;",
    "",
  ].join("\n");
  const hidden = classifyCarry(connectorSection, connectorSection + binaryThenDdl);
  assert.equal(hidden.evidence.database.sources[0]?.state, "changed");

  // `git apply` uses the rename names, so they meet the path rules too.
  const renamed = [
    "diff --git a/docs/notes.md b/docs/notes.md",
    "similarity index 100%",
    "rename from apps/hosted/server/src/implementation/migrations.ts",
    "rename to docs/notes.md",
    "",
  ].join("\n");
  assert.equal(classifyCarry(connectorSection, connectorSection + renamed).evidence.database.sources[0]?.state, "changed");
});

test("registry sensitivity flags still force a change for clean content", () => {
  const report = classifyCarry(connectorSection, connectorSection + outboundSection, { database: true, workflow: true });
  assert.equal(report.databaseChanged, true);
  assert.equal(report.workflowChanged, true);
  assert.equal(report.evidence.database.sources[0]?.state, "changed");
  assert.equal(report.evidence.workflow.sources[0]?.state, "changed");
});
