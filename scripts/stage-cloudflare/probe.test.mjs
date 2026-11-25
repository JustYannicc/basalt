// Three refusals checked only by what reaches the account: whatever a stage tool hands the stage
// API, no request outside the stage's own resources is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stageCloudflare } from "./api.mjs";
import { accountId, outsideCalls, sharedAccount, stageReach } from "./test/stage-reach.mjs";

const prefix = "basalt-180-scale";
const setup = () => {
  const fake = sharedAccount(prefix);
  const reach = stageReach(fake, prefix);
  const api = stageCloudflare({ accountId, token: "t", prefix, fetcher: fake.fetcher });
  return { fake, reach, api };
};
const settle = (attempt) => attempt().catch(() => undefined);

test("refuses any path below a stage's own Worker", async () => {
  const { fake, reach, api } = setup();
  for (const below of [
    "/../basalt-production-poolworker/settings",
    "/%2e%2e/basalt-production-poolworker",
    "/%2E%2E/basalt-production-poolworker/settings",
    "/..%2fbasalt-production-poolworker",
  ])
    await settle(() => api.read("scripts", `${prefix}-gateway`, below));
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
  assert.ok(fake.live.scripts.some((row) => row.id === "basalt-production-poolworker"));
});

test("refuses a listed row changed after its listing", async () => {
  const { fake, reach, api } = setup();
  const [app] = (await api.inventory(["applications"])).applications.filter(
    (row) => row.id === "own-app",
  );
  app.id = "prod-app";
  await settle(() => api.remove("applications", app));
  app.id = "own-app";
  app.name = "basalt-production-poolcontainer";
  await settle(() => api.remove("applications", app));
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
  assert.ok(fake.live.applications.some((row) => row.id === "prod-app"));
});

test("refuses a found image changed after it was found", async () => {
  const { fake, reach, api } = setup();
  const [image] = await api.images();
  image.path = `${accountId}/basalt-poolcontainer-production`;
  image.tags = ["p1"];
  await settle(() => api.removeImage(image));
  image.name = "basalt-poolcontainer-production";
  await settle(() => api.removeImage(image));
  assert.deepEqual(outsideCalls(fake, prefix, reach), []);
  assert.deepEqual(fake.live.tags[`${accountId}/basalt-poolcontainer-production`], ["p1"]);
});
