import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { fixture, owner, pool, signingKey } from "../../src/pool/test/computers.ts";
import { acceptanceCredential } from "./acceptance-device.ts";
import { registerRehearsalAcceptanceDevice } from "./rehearsal-acceptance-device.ts";

const input = {
  stage: "test-rehearsal-3",
  origin: "https://rehearsal.example",
  signingKey,
  pool: pool.pool,
  owner,
  organization: pool.organization,
  user: owner,
};
const untouched: typeof fetch = async () => assert.fail("nothing may be sent");

test("the production stage is refused by name before anything else is read or sent", async () => {
  for (const extra of [{}, { signingKey: "", origin: "", pool: "" }]) {
    await assert.rejects(
      registerRehearsalAcceptanceDevice({ ...input, ...extra, stage: "production" }, untouched),
      /never registered on production/u,
    );
  }
});

test("only a test-rehearsal-<n> stage, never production's host, registers a device", async () => {
  for (const stage of ["test-x", "test-rehearsal-10", "test-rehearsal-1-x", "scale-1", ""])
    await assert.rejects(
      registerRehearsalAcceptanceDevice({ ...input, stage }, untouched),
      /test-rehearsal-<n>/u,
      stage,
    );
  await assert.rejects(
    registerRehearsalAcceptanceDevice({ ...input, origin: `https://${brand.host}` }, untouched),
    /production's host/u,
  );
  await assert.rejects(
    registerRehearsalAcceptanceDevice({ ...input, signingKey: "abc" }, untouched),
    /signing key/u,
  );
});

test("the stage pool's own registration makes a models-only device the release then signs for", async () => {
  const f = fixture();
  const device = await registerRehearsalAcceptanceDevice(
    input,
    async (url, init) => f.nativeControl(new Request(url, init)),
    f.now,
  );
  assert.deepEqual(Object.keys(device).sort(), ["computer", "grant", "pool", "user"]);
  assert.equal(device.user, owner);
  assert.equal(device.pool, pool.pool);
  assert.match(device.grant, /^native:/u);
  const row = (await f.registry())[device.computer];
  assert.equal(row?.state, "active");
  assert.deepEqual(
    { models: row?.native?.models, tools: row?.native?.toolsOrganization },
    { models: true, tools: undefined },
  );
  const credential = acceptanceCredential(
    { POOL_ACCEPTANCE_DEVICE: JSON.stringify(device), POOL_APP_SIGNING_KEY: signingKey },
    f.now,
  );
  const admitted = await f.nativeModel(
    new Request("https://pool.example/v1/models", { headers: await credential("GET", "/v1/models") }),
  );
  admitted.release();
  assert.equal(admitted.request.headers.get("authorization"), `Bearer ${f.server.keys[0]!.api_key}`);
});
