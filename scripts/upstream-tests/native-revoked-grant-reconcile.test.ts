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
/** Each pass also reads the pool's link-setup computers whose revoke left a tools key, once. */
const toolsRead = 1;

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
      d.asked() - asked <= batch + toolsRead,
      `pass ${passes} asked the pool ${d.asked() - asked} times`,
    );
    assert.ok(result.checked <= batch);
    if (result.checked === 0) break;
    checked += result.checked;
  }
  assert.equal(checked, others + 1, "every grant was checked once in the cycle");
  const asked = d.asked();
  assert.equal((await pass(d)).checked, 0, "a grant isn't asked about again so soon");
  assert.equal(d.asked(), asked + toolsRead);
});

/** Live tools-only grants whose pool rows say `state`, as the stores hold them. */
async function leftGrants(d: Device, count: number, state: "revoking" | "active") {
  const [live] = await d.f.adapter.findMany<{ clientId: string }>({
    model: "mcpGrant",
    where: [{ field: "userId", value: d.f.userId }],
  });
  assert.ok(live);
  const registry = await d.p.registry();
  const at = new Date();
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const id = `native:left-${String(index).padStart(5, "0")}`;
    const computer = `left-computer-${index}`;
    ids.push(id);
    await d.f.adapter.create({
      model: "mcpGrant",
      forceAllowId: true,
      data: {
        id,
        userId: d.f.userId,
        clientId: live.clientId,
        resource: `${origin}/native`,
        policy: JSON.stringify({
          kind: "native",
          models: false,
          computer,
          pool: pool.pool,
          toolsOrganization: d.team,
        }),
        revoked: false,
        createdAt: at,
        updatedAt: at,
      },
    });
    registry[computer] = {
      id: computer,
      name: "Left device",
      user: d.f.userId,
      pool: pool.pool,
      state,
      createdAt: at.toISOString(),
      boundAt: at.toISOString(),
      firstModelRequestAt: null,
      firstToolCallAt: null,
      revokedAt: null,
      native: { grant: id, models: false, toolsOrganization: d.team },
    };
  }
  await d.p.storage.put("computer-registry-v1", registry);
  return ids;
}
const revokedGrant = async (d: Device, id: string) =>
  (
    await d.f.adapter.findOne<{ revoked: boolean }>({
      model: "mcpGrant",
      where: [{ field: "id", value: id }],
    })
  )?.revoked;

test("a grant whose revoke fails stays due while the pass revokes the next one", async (t) => {
  const d = await device(t, false);
  const [first, second] = await leftGrants(d, 2, "revoking");
  // The grant store refuses the first grant's revoke, as a failing database would.
  d.db.exec(
    `CREATE TRIGGER refuse_revoke BEFORE UPDATE ON mcpGrant WHEN OLD.id = '${first}'
      BEGIN SELECT RAISE(ABORT, 'synthetic storage refusal'); END`,
  );
  const refused = await pass(d).catch(() => undefined);
  assert.equal(refused?.revoked, 1, "the second grant was revoked in the same pass");
  assert.equal(await revokedGrant(d, first!), false);
  assert.equal(await revokedGrant(d, second!), true);
  d.db.exec("DROP TRIGGER refuse_revoke");
  const next = await pass(d);
  assert.equal(next.revoked, 1, "the next pass revokes the first one");
  assert.equal(await revokedGrant(d, first!), true);
});

test("a pass the pool stops answering midway resumes where it stopped", async (t) => {
  const d = await device(t, false);
  const others = await leftGrants(d, 120, "active");
  d.failAfter(30);
  const cut = await pass(d);
  assert.equal(cut.unavailable, true);
  assert.equal(cut.checked, 30);
  d.recover();
  let checked = cut.checked;
  for (;;) {
    const result = await pass(d);
    if (result.checked === 0) break;
    checked += result.checked;
  }
  assert.equal(checked, others.length + 1, "each grant was checked once across the outage");
});

test("a person-revoked device the pool later finished as removed loses its tools", async (t) => {
  const d = await device(t, false);
  const { id } = await grantOf(d);
  const computer = await leftRevoking(d);
  // A row access removal finished before the pool recorded why: its person's revoke is lost.
  const registry = await d.p.registry();
  registry[computer]!.state = "removed";
  registry[computer]!.removedAt = new Date().toISOString();
  await d.p.storage.put("computer-registry-v1", registry);
  const result = await pass(d);
  assert.equal(result.revoked, 1);
  await assertEnded(d, id);
});

test("a device restored without history keeps its tools", async (t) => {
  const d = await device(t, false);
  const computer = await leftRevoking(d);
  // Access came back to a row that kept no record of its state before removal.
  const registry = await d.p.registry();
  registry[computer]!.restoredWithoutHistory = true;
  await d.p.storage.put("computer-registry-v1", registry);
  const result = await pass(d);
  assert.equal(result.checked, 1);
  assert.equal(result.revoked, 0, "its person may never have revoked it");
  assert.equal((await grantOf(d)).revoked, false);
  assert.equal((await d.access(d.tokens.access_token)).status, 200);
});
