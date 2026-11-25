import assert from "node:assert/strict";
import { test } from "node:test";
import { empty, inventory, removeAll } from "./cloudflare.ts";
import { fakeCloudflare } from "./test/fake-cloudflare.ts";

const stage = "test-route-scratch-1" as const;

test("the read-back sees the stage's image, and only the stage's", async () => {
  const { account } = fakeCloudflare();
  const found = await inventory(account, stage);
  assert.deepEqual(
    found.images.map((image) => image.repository),
    ["acct/basalt-route-scratch-1-route-gateway"],
  );
  assert.equal(empty(found), false);
});

test("a destroy deletes the stage's image and leaves every other repository alone", async () => {
  const { account, repositories, credentials, deletes } = fakeCloudflare();
  const failed = await removeAll(account, stage, await inventory(account, stage));
  assert.deepEqual(failed, []);
  assert.equal(repositories.get("acct/basalt-route-scratch-1-route-gateway")!.size, 0);
  assert.equal(
    repositories.get("acct/basalt-rehearsal-pool-test-rehearsal-1-abcdefghijklmnop")!.size,
    1,
  );
  assert.equal(repositories.get("acct/basalt-route-scratch-1-route-gateway-other")!.size, 1);
  assert.ok(deletes.every((path) => !path.includes("rehearsal") && !path.endsWith("-other")));
  assert.equal(empty(await inventory(account, stage)), true);
  // Reading asks only to pull; only the delete asks for push, and every grant lasts 15 minutes.
  assert.deepEqual(
    credentials.map((body) => body.permissions.join("+")),
    ["pull", "pull+push", "pull"],
  );
  assert.ok(credentials.every((body) => body.expiration_minutes === 15));
});

test("the read-back fails while an image remains", async () => {
  const { account } = fakeCloudflare({ refuseImageDelete: true });
  const failed = await removeAll(account, stage, await inventory(account, stage));
  assert.deepEqual(failed, ["image"]);
  const after = await inventory(account, stage);
  assert.equal(after.applications.length + after.scripts.length + after.namespaces.length, 0);
  assert.equal(after.images.length, 1);
  assert.equal(empty(after), false);
});
