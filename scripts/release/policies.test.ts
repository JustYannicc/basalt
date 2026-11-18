import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Effect } from "effect";
import { decodePlanPolicy } from "./plan-check.ts";

const read = async (name: string) =>
  JSON.parse(await readFile(new URL(`./policies/${name}.json`, import.meta.url), "utf8"));
// The pin is supplied at run time from POOL_ROOT_IMAGE; it carries the account id, never committed.
const image = `registry.cloudflare.com/${"0".repeat(32)}/pool@sha256:${"a".repeat(64)}`;

for (const name of ["release", "code", "cutover-code", "cutover-classes"])
  test(`the ${name} policy decodes once the pin is supplied`, async () => {
    const policy = await read(name);
    assert.equal(policy.check.poolContainer.image, "");
    await Effect.runPromise(
      decodePlanPolicy({
        ...policy.check,
        poolContainer: { ...policy.check.poolContainer, image },
        ...(policy.include ? { include: policy.include } : {}),
      }),
    );
    for (const key of Object.keys(policy.env ?? {}))
      assert.ok(
        ["POOL_FLEET_BUILD", "POOL_FLEET_CLASSES", "POOL_WORKER_VERSION_TRAFFIC"].includes(key),
      );
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
