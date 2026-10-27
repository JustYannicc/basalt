// Cases a second review found: the identity of the Workflows' host and state store, edits inside
// dependency patches, and hunks that only move. Excerpts follow the pinned upstream.
import assert from "node:assert/strict";
import test from "node:test";
import { addition, classifyCarry, connectorSection, nestedPatch, section, states } from "./carry.test-helpers.ts";

const adding = (fixture: string) => states(classifyCarry(connectorSection, connectorSection + fixture));

test("the stage, the API Worker name and the Alchemy state store are Workflow and database identity", () => {
  // stage.ts: the production stage and the API Worker name every Workflow binding resolves to.
  const stage = section("apps/hosted/cloud/src/infrastructure/stage.ts", ["/** The stage that serves production. */"],
    ["export const productionStage = \"v2\";"], ["export const productionStage = \"production\";"]);
  assert.deepEqual(adding(stage), { database: "changed", workflow: "changed" });
  const worker = section("apps/hosted/cloud/src/infrastructure/stage.ts", ["/** The production API Worker. */"],
    ["export const productionApiWorkerName = \"executor-next-hosted-api-v2-qs32brgjwvt7ytx4\";"],
    ["export const productionApiWorkerName = \"executor-next-hosted-api-v3\";"]);
  assert.deepEqual(adding(worker), { database: "changed", workflow: "changed" });

  // main.ts: the production API Worker keeps its name only through this prop.
  const name = (path: string) => section(path, ["      Option.getOrUndefined(yield* stageName) === productionStage"],
    ["        ? { name: productionApiWorkerName }"], ["        ? {}"]);
  assert.equal(adding(name("apps/hosted/cloud/src/main.ts")).workflow, "changed");
  assert.equal(adding(name("apps/hosted/cloud/src/infrastructure/entry.ts")).workflow, "changed");

  // state.ts: which stages keep Alchemy state locally instead of in Cloudflare.
  const state = section("apps/hosted/cloud/src/infrastructure/state.ts", ["import { stageName } from \"./stage.ts\";", ""],
    ["export const localStages = new Set([\"development\"]);"], ["export const localStages = new Set([\"development\", \"production\"]);"]);
  assert.deepEqual(adding(state), { database: "changed", workflow: "changed" });
  const store = section("apps/hosted/cloud/src/infrastructure/stack-state.ts", ["      !name.value.startsWith(\"e2e-\")"],
    ["      ? Cloudflare.state()"], ["      ? Alchemy.localState()"]);
  assert.deepEqual(adding(store), { database: "changed", workflow: "changed" });
});

test("a Workflow body in a module whose name lacks Workflow is still Workflow-changing", () => {
  // provisioning.ts holds `class Provisioning extends Cloudflare.Workflow`.
  const body = section("apps/hosted/cloud/src/infrastructure/provisioning.ts", [
    "      user: (id) =>",
    "        emails.deliverUser(id).pipe(",
    "          Effect.provide(RuntimeContext.phantom),",
    "          Effect.mapError(() => new ProvisioningFailed()),",
    "        ),",
  ], ["      billing: (id) => meter.syncSeats(id).pipe(Effect.mapError(() => new ProvisioningFailed())),"],
  ["      billing: (id) => meter.syncMembers(id).pipe(Effect.mapError(() => new ProvisioningFailed())),"]);
  assert.equal(adding(body).workflow, "changed");
});

/** A carry section editing the dependency patch `patch` at inner file `inner`. */
function dependencyEdit(patch: string, inner: string, line: string): string {
  return nestedPatch([
    ` diff --git a/${inner} b/${inner}`,
    " @@ -18,7 +18,7 @@ import * as Output from \"./Output.js\";",
    `+${line}`,
  ], patch);
}

test("an edit inside a dependency patch is judged by the dependency it patches", () => {
  // alchemy provisions the Workflow hosts and the database: lib/Apply.js decides instance ids.
  const alchemy = states(classifyCarry(
    dependencyEdit("alchemy@2.0.0-beta.80.patch", "lib/Apply.js", "-    return node.state.instanceId;"),
    dependencyEdit("alchemy@2.0.0-beta.80.patch", "lib/Apply.js", "+    return yield* generateInstanceId();"),
  ));
  assert.deepEqual(alchemy, { database: "changed", workflow: "changed" });

  // Patch names encode `/` as %2F.
  const sql = states(classifyCarry(
    dependencyEdit("@effect%2Fsql-pg@4.0.1.patch", "dist/esm/PgClient.js", "-  const retries = 1;"),
    dependencyEdit("@effect%2Fsql-pg@4.0.1.patch", "dist/esm/PgClient.js", "+  const retries = 2;"),
  ));
  assert.equal(sql.database, "changed");

  // Any other dependency is not known to be safe.
  const other = states(classifyCarry(
    dependencyEdit("effect@4.0.1.patch", "dist/esm/Fiber.js", "-  const retries = 1;"),
    dependencyEdit("effect@4.0.1.patch", "dist/esm/Fiber.js", "+  const retries = 2;"),
  ));
  assert.deepEqual(other, { database: "unknown", workflow: "unknown" });
});

test("nested patch lines are judged without their own diff prefix", () => {
  const column = (type: string) => dependencyEdit("effect@4.0.1.patch", "dist/esm/model.js", `+  owner ${type},`);
  assert.equal(states(classifyCarry(column("text"), column("integer"))).database, "changed");
});

test("a hunk that only moves is judged by every line it adds", () => {
  const moved = (after: number) => addition("apps/hosted/cloud/src/implementation/startup.ts", [
    "  const client = yield* connect;",
    "  await client.query(\"begin\");",
    "  const owner = settings.owner;",
    "  const runtime = settings.runtime;",
    "  const reader = settings.reader;",
    "  await client.query(\"grant executor_admin to executor_runtime\");",
    "  await client.query(\"commit\");",
  ], after);
  assert.equal(states(classifyCarry(connectorSection + moved(40), connectorSection + moved(90))).database, "changed");

  // An edit moved past one context line under the same header.
  const within = (lines: string[]) => [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -10,2 +10,3 @@",
    ...lines,
    "",
  ].join("\n");
  const report = states(classifyCarry(
    connectorSection + within(["   },", "+  \"alchemy\": \"2.0.0\",", "   \"devDependencies\": {"]),
    connectorSection + within(["+  \"alchemy\": \"2.0.0\",", "   },", "   \"devDependencies\": {"]),
  ));
  assert.deepEqual(report, { database: "changed", workflow: "changed" });
});

test("the stack's state store and stage name are database identity wherever they are used", () => {
  // Upstream alchemy.run.ts passes `state: stackState` to its stack.
  const stack = section("apps/hosted/cloud/src/infrastructure/stack.ts", ["export default Alchemy.Stack("], ["  { providers, state: stackState },"], ["  { providers, state: otherState },"]);
  assert.equal(adding(stack).database, "changed");
});
