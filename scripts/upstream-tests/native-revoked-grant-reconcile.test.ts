// A tools-only device's own checks never ask the pool, so a device revoked before its grant ended
// first could keep its tools. The host's every-minute pass checks live tools-only grants against
// the pool and ends any the pool says its person revoked. The pool here is the real control
// endpoint served over HTTP; its outage is its Worker's own failure response.
import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "../../src/pool/test/computers.ts";
import { device, origin } from "./native-pool-device-fixture.ts";

type Device = Awaited<ReturnType<typeof device>>;
/** Live grants one pass reads at most. */
const batch = 50;

const pass = (d: Device) => d.f.api.retryNativeCleanups({});
const grantOf = async (d: Device) => {
  const grant = await d.f.adapter.findOne<{ id: string; revoked: boolean }>({
    model: "mcpGrant",
    where: [{ field: "userId", value: d.f.userId }],
  });
  assert.ok(grant);
  return grant;
};
/** A device revoked at the pool by a release before the host ended grants first. */
async function leftRevoking(d: Device) {
  const registry = await d.p.registry();
  const [computer] = Object.keys(registry);
  assert.ok(computer);
  registry[computer]!.state = "revoking";
  await d.p.storage.put("computer-registry-v1", registry);
  return computer;
}
async function assertEnded(d: Device, grant: string) {
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
  assert.equal((await d.refresh(d.tokens.refresh_token)).status, 400);
  assert.equal((await grantOf(d)).revoked, true);
  // Every forwarded tool call reads its bearer's token row; none is left to read.
  const tokens = await d.f.adapter.findMany({
    model: "oauthAccessToken",
    where: [{ field: "referenceId", value: grant }],
  });
  assert.deepEqual(tokens, []);
}

test("a tools-only grant whose device the pool reports revoking loses its tools on the next pass", async (t) => {
  const d = await device(t, false);
  const { id } = await grantOf(d);
  // No access check here: an allowed answer is remembered for 3 seconds, which would serve the
  // check below. The refusal is bounded by that memory, as for any revoke.
  const computer = await leftRevoking(d);
  const result = await pass(d);
  assert.equal(result.checked, 1);
  assert.equal(result.revoked, 1);
  await assertEnded(d, id);
  assert.equal((await d.p.registry())[computer]?.state, "revoked", "the pool finished it too");
});

test("a tools-only grant whose device is healthy keeps its tools", async (t) => {
  const d = await device(t, false);
  const result = await pass(d);
  assert.equal(result.checked, 1);
  assert.equal(result.revoked, 0);
  assert.equal((await grantOf(d)).revoked, false);
  assert.equal((await d.access(d.tokens.access_token)).status, 200);
  assert.equal((await d.refresh(d.tokens.refresh_token)).status, 200);
});

test("while the pool doesn't answer the pass changes nothing, and the next one resumes", async (t) => {
  const d = await device(t, false);
  const { id } = await grantOf(d);
  await leftRevoking(d);
  d.fail();
  const down = await pass(d);
  assert.equal(down.unavailable, true);
  assert.equal(down.checked, 0);
  assert.equal((await grantOf(d)).revoked, false, "nothing changed");

  d.recover();
  const back = await pass(d);
  assert.equal(back.unavailable, false);
  assert.equal(back.revoked, 1);
  await assertEnded(d, id);
});

test("one pass asks the pool about at most a batch of grants, and a grant once per cycle", async (t) => {
  const d = await device(t, false);
  const own = await grantOf(d);
  const [live] = await d.f.adapter.findMany<{ policy: string; clientId: string }>({
    model: "mcpGrant",
    where: [{ field: "id", value: own.id }],
  });
  assert.ok(live);
  // Thousands of other people's tools-only devices, as the grant store holds them.
  const others = 2_000;
  const at = new Date();
  for (let index = 0; index < others; index++)
    await d.f.adapter.create({
      model: "mcpGrant",
      forceAllowId: true,
      data: {
        id: `native:other-${String(index).padStart(5, "0")}`,
        userId: d.f.userId,
        clientId: live.clientId,
        resource: `${origin}/native`,
        policy: JSON.stringify({
          kind: "native",
          models: false,
          computer: `other-computer-${index}`,
          pool: pool.pool,
          toolsOrganization: d.team,
        }),
        revoked: false,
        createdAt: at,
        updatedAt: at,
      },
    });
  let checked = 0;
  let passes = 0;
  for (;;) {
    const asked = d.asked();
    const result = await pass(d);
    passes++;
    assert.ok(
      d.asked() - asked <= batch,
      `pass ${passes} asked the pool ${d.asked() - asked} times`,
    );
    assert.ok(result.checked <= batch);
    if (result.checked === 0) break;
    checked += result.checked;
  }
  assert.equal(checked, others + 1, "every grant was checked once in the cycle");
  const asked = d.asked();
  assert.equal((await pass(d)).checked, 0, "a grant isn't asked about again so soon");
  assert.equal(d.asked(), asked);
});
