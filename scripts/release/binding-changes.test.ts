import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { bindingChanges, bindingChangesReport, forceListOf } from "./binding-changes.ts";
import { planDigest } from "./plan-check.ts";
import { safeJson } from "./safe-json.ts";
import { calledRows, makePlan, productionRows, type PlanInput } from "./test/plan-fixture.ts";

// Values that must never reach a public line, recorded in State and then declared anew.
const recordedSecret = "recorded-secret-value-A1b2C3d4";
const declaredSecret = "declared-secret-value-Z9y8X7w6";
const recordedPlain = "recorded-plain-value-K5l6";
const declaredPlain = "declared-plain-value-M7n8";

/** Production's rows with the store's Worker recorded as `first` declares it, then planned anew. */
async function replanned(
  context: TestContext,
  first: PlanInput["declared"],
  then: PlanInput["declared"],
) {
  const { rows } = await makePlan(context, {
    rows: { ...productionRows(), ...calledRows() },
    declared: first,
    settle: ["Api", "Catalog", "ArtifactsCredentials"],
  });
  return (await makePlan(context, { rows, declared: then })).plan;
}

const store = (changes: ReturnType<typeof bindingChanges>) =>
  changes.find(({ worker }) => worker === "ArtifactsCredentials")?.changes ?? [];

test("a changed secret is named with its type, never its value, and the verdict follows the list", async (context) => {
  const plan = await replanned(
    context,
    { credentials: { secret: recordedSecret } },
    { credentials: { secret: declaredSecret } },
  );
  const changes = bindingChanges(plan);
  assert.deepEqual(
    store(changes).find(({ name }) => name === "POOL_APP_SIGNING_KEY"),
    { name: "POOL_APP_SIGNING_KEY", type: "secret_text" },
  );
  const unlisted = bindingChangesReport(plan, []);
  assert.match(
    unlisted,
    /^By declared type, every changed secret is on forceSecrets: NO\. Not on it: .*ArtifactsCredentials: POOL_APP_SIGNING_KEY/mu,
  );
  assert.match(unlisted, /ArtifactsCredentials: .*POOL_APP_SIGNING_KEY \(declared secret_text\)/u);
  // Listing the store's secret takes it, and only it, off the verdict's list.
  assert.doesNotMatch(
    bindingChangesReport(plan, ["POOL_APP_SIGNING_KEY"]),
    /Not on it: .*ArtifactsCredentials: POOL_APP_SIGNING_KEY/u,
  );
  // Every secret the report names, listed: the verdict is yes.
  const secrets = changes.flatMap(({ changes: names }) =>
    names.filter(({ type }) => type.split("+").includes("secret_text")).map(({ name }) => name),
  );
  assert.match(
    bindingChangesReport(plan, secrets),
    /^By declared type, every changed secret is on forceSecrets: yes\.$/mu,
  );
  // The public lines, and everything they are built from, carry no value: neither of these, nor
  // the fixture's other secrets.
  for (const text of [unlisted, safeJson(changes)])
    for (const value of [
      recordedSecret,
      declaredSecret,
      "synthetic-management-secret",
      "synthetic-deployment-key",
      "synthetic-database-password",
    ])
      assert.equal(text.includes(value), false, value);
});

test("a changed plain value prints its name and type only", async (context) => {
  const plan = await replanned(
    context,
    { credentials: {}, credentialsEnv: { MODE: recordedPlain } },
    { credentials: {}, credentialsEnv: { MODE: declaredPlain } },
  );
  const report = bindingChangesReport(plan, []);
  assert.deepEqual(
    store(bindingChanges(plan)).find(({ name }) => name === "MODE"),
    { name: "MODE", type: "plain_text" },
  );
  for (const value of [recordedPlain, declaredPlain])
    assert.equal(report.includes(value), false, value);
});

test("reading the plan for the line leaves the plan's digest byte for byte as it was", async (context) => {
  const plan = await replanned(
    context,
    { credentials: { secret: recordedSecret } },
    { credentials: { secret: declaredSecret } },
  );
  const before = planDigest(plan);
  bindingChangesReport(plan, ["POOL_APP_SIGNING_KEY"]);
  bindingChanges(plan);
  assert.equal(planDigest(plan), before);
});

test("the force list is read from any policy shape, and a policy without one lists nothing", () => {
  assert.deepEqual(forceListOf({ rollback: { forceSecrets: ["A_ONE", 2, "B_TWO"] } }), [
    "A_ONE",
    "B_TWO",
  ]);
  for (const policy of [undefined, {}, { rollback: {} }, { rollback: { forceSecrets: "A" } }])
    assert.deepEqual(forceListOf(policy), []);
});
