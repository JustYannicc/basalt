// Cases an adversarial review found the first carry rules missed. Excerpts follow the pinned
// upstream's own code where it has one.
import assert from "node:assert/strict";
import test from "node:test";
import { addition, classifyCarry, connectorSection, nestedPatch, section, states } from "./carry.test-helpers.ts";

const neutral = "apps/hosted/cloud/src/implementation/startup.ts";

/** Classifies a carry that gains `fixture` beside the connector section. */
const adding = (fixture: string) => states(classifyCarry(connectorSection, connectorSection + fixture));

/** Classifies a carry whose added lines for `path` change from `before` to `after`. */
const editing = (path: string, before: string[], after: string[]) =>
  states(classifyCarry(connectorSection + addition(path, before), connectorSection + addition(path, after)));

test("role membership, ownership and role settings are database-changing", () => {
  const cases = [
    // Shaped like the preview runtime role script's grants.
    "  await client.query(\"grant executor_admin to executor_runtime\");",
    "  yield* sql.unsafe(`GRANT ${owner} TO ${identifier(runtimeRole)}`);",
    "  yield* sql.unsafe(`REVOKE executor_admin FROM ${identifier(runtimeRole)}`);",
    "  yield* sql`REASSIGN OWNED BY executor_migration TO postgres`;",
    "  yield* sql`DROP OWNED BY executor_preview`;",
    "  yield* sql`alter table hosted_groups owner to executor_owner`;",
    "  yield* sql.unsafe(`ALTER ${kind} ${owner} SET search_path = public`);",
  ];
  for (const line of cases)
    assert.equal(adding(section(neutral, ["  const sql = yield* SqlClient.SqlClient;"], [], [line])).database, "changed", line);
});

test("Better Auth options are database schema", () => {
  // The organization plugin options in auth-options.ts, which the auth migrator turns into tables.
  const teams = section("apps/hosted/cloud/src/implementation/auth-options.ts", [
    "        disableOrganizationDeletion: true,",
    "        requireEmailVerificationOnInvitation: true,",
  ], [], ["        teams: { enabled: true },"]);
  assert.equal(adding(teams).database, "changed");

  // The same options assembled elsewhere still count.
  const plugin = section("apps/hosted/self-host/src/implementation/sign-in.ts", ["      oauthProxyLocationGuard(),"], [], ["      twoFactor({ issuer: brand.name }),"]);
  assert.equal(adding(plugin).database, "changed");
  const fields = section("apps/hosted/self-host/src/implementation/sign-in.ts", ["    user: {"], [], ["      additionalFields: { region: { type: \"string\" } },"]);
  assert.equal(adding(fields).database, "changed");
});

test("a SQL change far from its statement keyword is database-changing", () => {
  // Shaped like app-account-schema.ts: the index column list grows five lines below `create`.
  const index = (columns: string[]) => [
    "  yield* sql`create unique index if not exists hosted_app_account_links_app",
    "    on hosted_app_account_links (",
    "      app,",
    "      requirement,",
    ...columns,
    "    )`;",
    "  // One app link per app, requirement and account.",
  ];
  const report = editing("apps/hosted/server/src/implementation/links.ts", index(["      account"]), index(["      account,", "      kind"]));
  assert.equal(report.database, "changed");

  const fragments = [
    // A CHECK continuation, as in resource-schema.ts.
    "      or (kind = 'shared' and personal_user_id is null and audience is not null)),",
    "    where revoked_at is null`;",
    "    include (linked_by)",
    "    with (fillfactor = 70)",
    "    tags text[],",
    "    score double precision,",
    "    email citext,",
    "    address inet,",
    "    ttl interval,",
    "    status app_status,",
    "    created_at timestamp with time zone,",
  ];
  for (const line of fragments)
    assert.equal(adding(section(neutral, ["  // fragment"], [], [line])).database, "changed", line);
});

test("a change inside a template whose start is not visible is unknown without a keyword", () => {
  const unbounded = section("apps/hosted/server/src/implementation/links.ts", [
    "      app,",
    "      requirement,",
  ], ["      account"], ["      account, kind"], ["    )`;", "  // next"]);
  assert.equal(adding(unbounded).database, "unknown");
  assert.equal(adding(unbounded).workflow, "none");
});

test("Durable Object storage identity is database state", () => {
  const cases = [
    // packages/app-data/src/cloudflare.ts: the facet name keys the app's stored data.
    section("packages/app-data/src/cloudflare.ts", ["          Schema.decodeUnknownSync(FacetEntrypoint)("], ["            state.facets.get(\"data\", () => {"], ["            state.facets.get(\"store\", () => {"]),
    // apps/hosted/cloud/src/infrastructure/app-data.ts: class identity and its transfer.
    section("apps/hosted/cloud/src/infrastructure/supervisors.ts", ["export class AppDataSupervisor extends Cloudflare.DurableObject<AppDataSupervisor, Supervisor>()("], ["  { transferredFrom: \"Api\" },"], ["  { transferredFrom: \"ApiV2\" },"]),
    section("apps/hosted/cloud/src/infrastructure/supervisors.ts", ["// Supervisors"], ["export class AppDataSupervisor extends Cloudflare.DurableObject<AppDataSupervisor, Supervisor>()("], []),
    // durable-declarations.ts: the key that picks an app's object.
    section("apps/hosted/cloud/src/infrastructure/declarations.ts", ["      databases"], ["        .getByName(app)"], ["        .getByName(`${app}:v2`)"]),
    section(neutral, ["const namespace = env.SESSIONS;"], ["const id = namespace.idFromName(name);"], ["const id = namespace.jurisdiction(\"eu\").idFromName(name);"]),
    section("apps/hosted/cloud/wrangler.json", ["  \"migrations\": [{"], ["    \"new_sqlite_classes\": [\"Sessions\"]"], ["    \"renamed_classes\": [{ \"from\": \"Sessions\", \"to\": \"McpSessions\" }]"]),
  ];
  for (const fixture of cases) assert.equal(adding(fixture).database, "changed", fixture);
});

test("the EU carry's namespace scoping is database state by rule, not only by its flag", () => {
  const scoped = nestedPatch([
    " diff --git a/lib/Cloudflare/Workers/cloudflare_workers.js b/lib/Cloudflare/Workers/cloudflare_workers.js",
    " @@ -9,7 +9,8 @@ import * as Effect from \"effect/Effect\";",
    "++export function scopeEuNamespaces(env) {",
    "++  return value.jurisdiction(\"eu\");",
  ]);
  const unscoped = nestedPatch([
    " diff --git a/lib/Cloudflare/Workers/cloudflare_workers.js b/lib/Cloudflare/Workers/cloudflare_workers.js",
    " @@ -9,7 +9,8 @@ import * as Effect from \"effect/Effect\";",
    "++export function scopeEuNamespaces(env) {",
  ]);
  assert.equal(states(classifyCarry(unscoped, scoped)).database, "changed");
});

test("the Worker hosting Workflows, its stack and physical names are Workflow identity", () => {
  // api-worker.ts: the logical id Workflow bindings resolve through.
  const api = section("apps/hosted/cloud/src/infrastructure/api-worker.ts", ["import * as Cloudflare from \"alchemy/Cloudflare\";"],
    ["export class Api extends Cloudflare.Worker<Api, {}>()(\"Api\") {}"], ["export class Api extends Cloudflare.Worker<Api, {}>()(\"ApiV2\") {}"]);
  assert.equal(adding(api).workflow, "changed");

  // alchemy.run.ts: the stack name, two lines below `Alchemy.Stack(`.
  const stack = section("apps/hosted/cloud/alchemy.run.ts", ["export default Alchemy.Stack("], ["  \"executor-next-hosted\","], ["  \"basalt-next-hosted\","]);
  assert.equal(adding(stack).workflow, "changed");

  // alchemy's physical-name code inside the nested dependency patch.
  const before = nestedPatch([" diff --git a/lib/PhysicalName.js b/lib/PhysicalName.js", " @@ -1,3 +1,3 @@", "+-const separator = \"-\";"]);
  const after = nestedPatch([" diff --git a/lib/PhysicalName.js b/lib/PhysicalName.js", " @@ -1,3 +1,3 @@", "+-const separator = \"_\";"]);
  assert.equal(states(classifyCarry(before, after)).workflow, "changed");
});

test("dependency version changes are database or Workflow changes, or unknown", () => {
  const bump = (name: string) => section("package.json", ["  \"dependencies\": {"], [`    "${name}": "1.0.0",`], [`    "${name}": "1.0.1",`]);
  assert.equal(adding(bump("better-auth")).database, "changed");
  assert.equal(adding(bump("@effect/sql-pg")).database, "changed");
  assert.equal(adding(bump("fumadb-effect")).database, "changed");
  assert.deepEqual(adding(bump("alchemy")), { database: "changed", workflow: "changed" });
  assert.equal(adding(bump("@distilled.cloud/cloudflare")).workflow, "changed");
  assert.deepEqual(adding(bump("zod")), { database: "unknown", workflow: "unknown" });

  const patched = section("package.json", ["  \"patchedDependencies\": {"], [], ["    \"zod@4.1.0\": \"patches/zod@4.1.0.patch\","]);
  assert.deepEqual(adding(patched), { database: "unknown", workflow: "unknown" });
  const lock = section("bun.lock", ["  \"packages\": {"], ["    \"zod\": [\"zod@4.1.0\"],"], ["    \"zod\": [\"zod@4.1.1\"],"]);
  assert.deepEqual(adding(lock), { database: "unknown", workflow: "unknown" });
  // One changed line cannot show whether it is a dependency, so every manifest line counts.
  const latest = section("package.json", ["  \"dependencies\": {"], ["    \"workerd\": \"1.2.3\","], ["    \"workerd\": \"latest\","]);
  assert.equal(adding(latest).workflow, "changed");
  const catalog = section("pnpm-workspace.yaml", ["catalog:"], ["  pg: ^8.11.0"], ["  pg: ^8.12.0"]);
  assert.equal(adding(catalog).database, "changed");
  const script = section("package.json", ["  \"scripts\": {"], [], ["    \"lint\": \"oxlint\","]);
  assert.deepEqual(adding(script), { database: "unknown", workflow: "unknown" });
});

test("template literals are found through typed tags, casts, nested templates and comments", () => {
  const ddl = (opener: string, closer: string) => editing("apps/hosted/server/src/implementation/links.ts", [
    opener,
    "      on hosted_app_account_links (",
    "        app,",
    "        requirement,",
    "        account",
    `      )${closer}`,
  ], [
    opener,
    "      on hosted_app_account_links (",
    "        app,",
    "        requirement,",
    "        account,",
    "        kind",
    `      )${closer}`,
  ]);
  assert.equal(ddl("  yield* sql<Row>`create index if not exists links_app", "`;").database, "changed");
  assert.equal(ddl("  const statement = `create index if not exists links_app", "` as const;").database, "changed");
  assert.equal(ddl("  /* index */ yield* sql`create index if not exists links_app", "`;").database, "changed");
  assert.equal(ddl("  yield* sql`create index ${concurrently ? sql`concurrently` : sql``} links_app", "`;").database, "changed");
});

test("a hunk inside a long SQL template with no backtick in view is not clear", () => {
  const report = adding(section("apps/hosted/server/src/implementation/links.ts", [
    "        from hosted_app_account_links",
    "        where app = ${app}",
  ], ["          and kind = 'shared'"], ["          and kind = 'personal'"]));
  assert.notEqual(report.database, "none");
});

test("an insertion that only moves within a SQL template is still judged by its template", () => {
  const block = (columns: string[]) => [
    "  yield* sql`create index if not exists links_app",
    "    on hosted_app_account_links (",
    ...columns,
    "    )`;",
  ];
  assert.equal(editing("apps/hosted/server/src/implementation/links.ts",
    block(["      app,", "      kind,", "      requirement,", "      account"]),
    block(["      app,", "      requirement,", "      kind,", "      account"])).database, "changed");
});

test("a nested dependency patch is also judged by the dependency it patches", () => {
  const nested = (line: string) => [
    "diff --git a/patches/better-auth@1.7.5.patch b/patches/better-auth@1.7.5.patch",
    "--- a/patches/better-auth@1.7.5.patch",
    "+++ b/patches/better-auth@1.7.5.patch",
    "@@ -1,2 +1,2 @@",
    " diff --git a/dist/client.mjs b/dist/client.mjs",
    `+${line}`,
    "",
  ].join("\n").replace("@@ -1,2 +1,2 @@", "@@ -1,1 +1,2 @@");
  assert.equal(states(classifyCarry(nested("+const retries = 1;"), nested("+const retries = 2;"))).database, "changed");
});

test("a nested header this cannot read leaves the following lines unknown", () => {
  const workers = [
    " diff --git a/lib/Cloudflare/Workers/cloudflare_workers.js b/lib/Cloudflare/Workers/cloudflare_workers.js",
    " @@ -9,7 +9,8 @@ import * as Effect from \"effect/Effect\";",
    "  export const platform = 1;",
  ];
  const before = nestedPatch(workers);
  const after = nestedPatch([
    ...workers,
    "+diff --git a/lib/Cloudflare/Queues/my queue.js b/lib/Cloudflare/Queues/my queue.js",
    "+@@ -1,1 +1,1 @@",
    "+-export const delay = 0;",
    "++export const delay = 5;",
  ]);
  assert.deepEqual(states(classifyCarry(before, after)), { database: "unknown", workflow: "unknown" });
});
