import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Effect } from "effect";
import { decodePlanPolicy } from "./plan-check.ts";
import { decodeReleasePolicy } from "./policy.ts";

const raw = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./policies/${name}.json`, import.meta.url), "utf8"));
const read = async (name: string) => decodeReleasePolicy(await raw(name));
// The pin is supplied at run time from POOL_ROOT_IMAGE; it carries the account id, never committed.
const image = `registry.cloudflare.com/${"0".repeat(32)}/pool@sha256:${"a".repeat(64)}`;

for (const name of ["release", "code", "code-restart", "cutover-code", "cutover-classes"])
  test(`the ${name} policy decodes whole, and its check once the pin is supplied`, async () => {
    const policy = await read(name);
    await Effect.runPromise(
      decodePlanPolicy({
        ...policy.check,
        poolContainer: { ...policy.check.poolContainer, image },
        ...(policy.include ? { include: policy.include } : {}),
      }),
    );
  });

test("a misspelt or unknown key fails the policy instead of switching a guard off", async () => {
  const classes = (await raw("cutover-classes")) as {
    wire: { expectLiveModule?: unknown; expectLiveModules?: unknown };
    env: Record<string, string>;
  };
  const misspelt = structuredClone(classes);
  misspelt.wire.expectLiveModules = misspelt.wire.expectLiveModule;
  delete misspelt.wire.expectLiveModule;
  assert.throws(() => decodeReleasePolicy(misspelt), /expectLiveModules/u);
  const configured = structuredClone(classes);
  configured.env.CLOUDFLARE_API_TOKEN = "x";
  assert.throws(() => decodeReleasePolicy(configured), /CLOUDFLARE_API_TOKEN/u);
});

test("only the class-change step may create a class, and only the two fleet classes on PoolWorker", async () => {
  for (const name of ["release", "code", "cutover-code"])
    assert.deepEqual((await read(name)).wire.sqliteClasses, {}, name);
  const classes = await read("cutover-classes");
  assert.deepEqual(classes.wire.sqliteClasses, {
    PoolWorker: ["PoolRuntimeBlue", "PoolRuntimeGreen"],
  });
  assert.deepEqual(classes.wire.expectLiveModule, ["PoolWorker"]);
});

test("the code-only step keeps the fleet classes absent and the data resources protected", async () => {
  const code = await read("cutover-code");
  assert.equal(code.env.POOL_FLEET_CLASSES, "absent");
  for (const name of ["release", "cutover-code", "cutover-classes"]) {
    const { fqns } = (await read(name)).check.protected;
    for (const fqn of [
      "PoolContainer",
      "VaultAttachments",
      "PublicSiteWaitlist",
      "ArtifactsCredentials",
    ])
      assert.ok(fqns.includes(fqn), `${name} protects ${fqn}`);
  }
});

test("an automatic release is code-only and keeps the fleet classes absent until the cutover", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /POLICY_NAME: \$\{\{ inputs\.policy \|\| 'code' \}\}/u);
  const code = await read("code");
  assert.equal(code.check.mode, "code-only");
  assert.equal(code.env.POOL_FLEET_CLASSES, "absent");
  assert.equal(code.include, undefined);
});

test("every policy that can update PoolWorker carries the readiness command that waits for adoption", async () => {
  for (const name of ["code", "code-restart", "cutover-code", "cutover-classes", "release"]) {
    const policy = await read(name);
    // No include means the whole stack is planned, the readiness command with it.
    if (policy.include) assert.ok(policy.include.includes("PoolBackendBudgetRuntimeReady"), name);
    if (policy.check.mode === "cutover-classes")
      assert.ok(
        policy.check.allow.some(
          (entry) => entry.fqn === "PoolBackendBudgetRuntimeReady" && entry.action === "update",
        ),
        name,
      );
  }
});

test("only the healing release declares a root restart, bounded, and it is otherwise the code policy", async () => {
  for (const name of ["release", "code", "cutover-code", "cutover-classes"])
    assert.equal((await read(name)).acceptance, undefined, name);
  const healing = await read("code-restart");
  const code = await read("code");
  assert.equal(healing.acceptance?.rootRestart.bound, "healingAcceptanceWithinMs");
  // No reviewed policy is an image release of the root: every one refuses any row on it.
  for (const name of ["release", "code", "code-restart", "cutover-code", "cutover-classes"])
    assert.equal((await read(name)).check.poolContainer.imageRelease, undefined, name);
  // Only the healing release admits the root's row the old layer left: its recorded hash alone.
  for (const name of ["release", "code", "cutover-code", "cutover-classes"])
    assert.equal((await read(name)).check.poolContainer.recordedHashOnly, undefined, name);
  // The attachment the plan cannot know while the pool Worker updates: the heal, the code release
  // and the class change, which all ship the pool Worker with the pool database command's outcome.
  for (const name of ["release", "cutover-code"])
    assert.equal((await read(name)).check.poolContainer.workerAttachment, undefined, name);
  assert.equal((await read("code")).check.poolContainer.workerAttachment, true);
  assert.equal((await read("cutover-classes")).check.poolContainer.workerAttachment, true);
  // No general loosening: apart from its named commands, the two connections that wait on them
  // and the root's old recorded hash, it is the code policy.
  const { commands, allow, poolContainer, removedBindings, ...rest } = healing.check;
  const { commands: _none, allow: codeAllow, poolContainer: codeRoot, ...codeRest } = code.check;
  const { recordedHashOnly, ...root } = poolContainer;
  assert.equal(recordedHashOnly, true);
  assert.equal(poolContainer.workerAttachment, true);
  assert.deepEqual(root, codeRoot);
  const { fixedBindings, ...wire } = healing.wire;
  const { fixedBindings: codeFixed, ...codeWire } = code.wire;
  assert.deepEqual(codeFixed, fixedBindings);
  // Both ship the bulk-import store's code under the same rule.
  assert.deepEqual(
    codeAllow,
    allow.filter((entry) => entry.fqn === "ArtifactsCredentials"),
  );
  assert.deepEqual(
    { check: rest, include: healing.include, wire, env: healing.env },
    { check: codeRest, include: code.include, wire: codeWire, env: code.env },
  );
  assert.ok(commands?.includes("Migrations") && commands.includes("PoolDatabase"));
  assert.deepEqual(
    allow.map((entry) => [entry.fqn, entry.action, entry.unresolvedOnly]),
    [
      ["ArtifactsCredentials", "update", undefined],
      ["DatabaseConnection", "update", true],
      // The deleted release layer's receipt: a command whose delete only drops its State row.
      ["PoolImagePublicationReceipt", "delete", undefined],
      ["PoolModelDatabaseConnection", "update", true],
    ],
  );
  // The one setting only the deleted layer read, by name; no other policy drops any binding.
  assert.deepEqual(
    removedBindings?.map((entry) => [entry.fqn, entry.sid]),
    [["PoolWorker", "POOL_PRESERVE_LEGACY_IMAGE"]],
  );
  for (const name of ["release", "code", "cutover-code", "cutover-classes"])
    assert.equal((await read(name)).check.removedBindings, undefined, name);
  // The store's Worker names what it holds of other resources, and the one value that moves
  // with every release; a secret is in neither list.
  assert.deepEqual(allow[0]?.codeOnly?.references, [
    { name: "POOL_AUTH_DATABASE", resource: "PoolModelDatabaseConnection" },
    { name: "TOOLS_SERVICE", resource: "Api" },
  ]);
  assert.deepEqual(
    allow[0]?.codeOnly?.values.map((value) => [value.name, value.fields]),
    [["EXECUTOR_TELEMETRY", ["version"]]],
  );
  assert.match(allow[0]?.codeOnly?.values[0]?.why ?? "", /build version/u);
  // Its code moves only with its uploads held to the serving bindings, and the reason is written.
  assert.deepEqual(fixedBindings, ["ArtifactsCredentials"]);
  assert.match(allow[0]?.codeOnly?.why ?? "", /version skew/u);
});

test("the code release admits the bulk-import store's code and the root's attachment as the heal does, and nothing else", async () => {
  const code = await read("code");
  const heal = await read("code-restart");
  // Every release from main carries the store's Worker (its telemetry setting holds the build
  // version), so the code release admits it under the heal's own rule, with its serving bindings.
  assert.deepEqual(
    code.check.allow,
    heal.check.allow.filter((entry) => entry.fqn === "ArtifactsCredentials"),
  );
  assert.deepEqual(code.wire.fixedBindings, ["ArtifactsCredentials"]);
  // The whole stack, no restart and no recorded-hash row: acceptance holds the same boot, and a
  // failure is undone by the Worker rollback.
  assert.equal(code.include, undefined);
  assert.equal(code.acceptance, undefined);
  assert.equal(code.check.poolContainer.recordedHashOnly, undefined);
  assert.equal(code.check.removedBindings, undefined);
  assert.equal(code.env.POOL_FLEET_CLASSES, "absent");
  assert.deepEqual(code.wire.sqliteClasses, {});
});

test("the class change expects the shared Secrets Store and the pool database command settled", async () => {
  const policy = await read("cutover-classes");
  // Production's State records the store, so the class change plans it noop. Every allow entry
  // must appear in the plan, so an entry for it would refuse the very plan it was written for.
  assert.ok(!policy.check.allow.some((entry) => entry.fqn === "PoolObservationSecrets"));
  // Keyed on what it reads, the command no longer re-runs: an update would be a change to review.
  assert.ok(!policy.check.allow.some((entry) => entry.fqn === "PoolDatabase"));
});

test("a release that rolls back may force only the telemetry secret, and one that cannot forces nothing", async () => {
  // EXECUTOR_TELEMETRY carries the release's build version, so it differs between any two releases.
  for (const name of ["code", "cutover-code", "release"])
    assert.deepEqual((await read(name)).rollback?.forceSecrets, ["EXECUTOR_TELEMETRY"], name);
  // These two have no rollback step: release.yml rolls back neither a heal nor a class change.
  for (const name of ["code-restart", "cutover-classes"])
    assert.equal((await read(name)).rollback, undefined, name);
});
