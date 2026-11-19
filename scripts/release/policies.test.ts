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
  const within = healing.acceptance?.rootRestart.withinSeconds ?? 0;
  assert.ok(within >= 60 && within <= 900, `bound ${within}`);
  // No general loosening: the plan rules, include, wire rules and switches are the code policy's.
  assert.deepEqual(
    { check: healing.check, include: healing.include, wire: healing.wire, env: healing.env },
    { check: code.check, include: code.include, wire: code.wire, env: code.env },
  );
});

test("the class change adopts the shared Secrets Store and expects the pool database command settled", async () => {
  const policy = await read("cutover-classes");
  assert.ok(
    policy.check.allow.some(
      (entry) => entry.fqn === "PoolObservationSecrets" && entry.action === "adopted",
    ),
  );
  // Keyed on what it reads, the command no longer re-runs: an update would be a change to review.
  assert.ok(!policy.check.allow.some((entry) => entry.fqn === "PoolDatabase"));
});
