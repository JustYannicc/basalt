// Revoking a device must end it at once, even while the pool's control plane is down: its grant
// and tokens go first, on the host. The pool's cleanup, the computer row and a model key at Home,
// follows once the pool answers. The pool here is the real control and setup code, and Connect is
// the real setup host; during an outage both pool endpoints answer as the pool Worker does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleSetup } from "../../src/setup/host.ts";
import { failureResponse } from "../../src/pool/json.ts";
import { nativeModelHeader, nativeModelPrefix } from "../../src/pool/native-contract.ts";
import { pool, signingKey } from "../../src/pool/test/computers.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { device, origin } from "./native-pool-device-fixture.ts";

type Device = Awaited<ReturnType<typeof device>>;

const grantOf = async (d: Device) => {
  const grant = await d.f.adapter.findOne<{ id: string; revoked: boolean }>({
    model: "mcpGrant",
    where: [{ field: "userId", value: d.f.userId }],
  });
  assert.ok(grant, "the approval recorded a grant");
  return grant;
};
const computerOf = async (d: Device) => {
  const [computer] = Object.keys(await d.p.registry());
  assert.ok(computer, "the approval registered a computer at the pool");
  return computer;
};
const stateOf = async (d: Device, computer: string) => (await d.p.registry())[computer]?.state;
const retry = (d: Device) => d.f.api.retryNativeCleanups({});
const pendingCleanups = (d: Device) =>
  d.f.adapter.findMany({
    model: "verification",
    where: [{ field: "identifier", operator: "starts_with", value: "native-cleanup:" }],
  });

/** Connect's Revoke button, through the real setup host. */
const connectRevoke = (d: Device, computer: string) =>
  handleSetup(
    new Request(`${origin}/setup/v1/computers/${computer}?intent=${encodeURIComponent(d.intent)}`, {
      method: "DELETE",
      headers: { cookie: d.f.cookies, origin },
    }),
    {
      POOL_APP_SIGNING_KEY: signingKey,
      TOOLS_SERVICE: { fetch: (request) => d.f.handler(request) },
      // The setup API runs in the same control plane as the native control endpoint.
      POOL_SERVICE: {
        fetch: async (request) => {
          if (d.down()) return failureResponse(new Error("synthetic controller outage"));
          d.p.advance(Date.now() - d.p.now());
          return d.p.setup(request);
        },
      },
    },
  );

/** The device's first model use, which mints its key at Home. */
async function mintKey(d: Device, computer: string, grant: string) {
  const path = "/v1/responses";
  const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
    user: d.f.userId,
    grant,
    computer,
    pool: pool.pool,
    expiresAt: d.p.now() + 10_000,
    method: "POST",
    path,
  });
  (
    await d.p.nativeModel(
      new Request(`https://pool.example${path}`, {
        method: "POST",
        headers: { [nativeModelHeader]: assertion },
        body: JSON.stringify({ model: "synthetic-model", stream: true }),
      }),
    )
  ).release();
  assert.equal(d.p.server.keys.length, 1, "the device holds a model key at Home");
}

/** The device is refused everywhere a tool call, model request or refresh would be checked. */
async function assertEnded(d: Device, grant: string) {
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
  const refreshed = await d.refresh(d.tokens.refresh_token);
  assert.equal(refreshed.status, 400, await refreshed.clone().text());
  assert.equal((await grantOf(d)).revoked, true);
  // Every forwarded tool call reads its bearer's token row; none is left to read.
  const tokens = await d.f.adapter.findMany({
    model: "oauthAccessToken",
    where: [{ field: "referenceId", value: grant }],
  });
  assert.deepEqual(tokens, []);
}

test("Connect's revoke ends a tools-only device at once while the pool's control plane fails", async (t) => {
  const d = await device(t, false);
  const computer = await computerOf(d);
  const { id } = await grantOf(d);
  d.fail();
  const removed = await connectRevoke(d, computer);
  assert.equal(removed.status, 200, await removed.clone().text());
  await assertEnded(d, id);
  assert.equal(await stateOf(d, computer), "active", "the pool hasn't heard yet");
  assert.deepEqual(await retry(d), { cleaned: 0, attempted: 1 });

  d.recover();
  assert.deepEqual(await retry(d), { cleaned: 1, attempted: 1 });
  assert.equal(await stateOf(d, computer), "revoked");
  assert.deepEqual(await retry(d), { cleaned: 0, attempted: 0 }, "nothing is left to retry");
});

test("a models device revoked while the pool's control plane fails loses its key once Home answers", async (t) => {
  const d = await device(t, true);
  const computer = await computerOf(d);
  const { id } = await grantOf(d);
  await mintKey(d, computer, id);

  d.fail();
  // The device's own revoke endpoint: it needs no answer from the pool.
  const revoked = await d.f.raw("/native/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${d.tokens.access_token}` },
  });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  await assertEnded(d, id);
  // Revoking it again on Connect still answers, and leaves one cleanup waiting.
  const again = await connectRevoke(d, computer);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await pendingCleanups(d)).length, 1);
  assert.equal(d.p.server.keys.length, 1, "the pool hasn't heard yet");

  // The pool answers again while Home is still stopped: the key stays until Home answers too.
  d.recover();
  d.p.server.stopped = true;
  assert.deepEqual(await retry(d), { cleaned: 0, attempted: 1 });
  assert.equal(d.p.server.keys.length, 1);
  assert.equal(await stateOf(d, computer), "revoking", "the pool stopped the device");

  d.p.server.stopped = false;
  assert.deepEqual(await retry(d), { cleaned: 1, attempted: 1 });
  assert.equal(d.p.server.keys.length, 0, "Home no longer holds the device's key");
  assert.equal(await stateOf(d, computer), "revoked");
  assert.deepEqual(await retry(d), { cleaned: 0, attempted: 0 });
});

test("Connect's revoke ends a models device at once while Home is stopped", async (t) => {
  const d = await device(t, true);
  const computer = await computerOf(d);
  const { id } = await grantOf(d);
  await mintKey(d, computer, id);
  d.p.server.stopped = true;
  const removed = await connectRevoke(d, computer);
  assert.equal(removed.status, 200, await removed.clone().text());
  await assertEnded(d, id);
  assert.equal(d.p.server.keys.length, 1, "Home hasn't answered yet");
  d.p.server.stopped = false;
  assert.deepEqual(await retry(d), { cleaned: 1, attempted: 1 });
  assert.equal(d.p.server.keys.length, 0);
  assert.equal(await stateOf(d, computer), "revoked");
});

test("a revoke whose cleanup can't be recorded leaves the device's grant as it was", async (t) => {
  const d = await device(t, false);
  const computer = await computerOf(d);
  // The auth store refuses the write; nothing is revoked half-way.
  d.db.exec("DROP TABLE verification");
  const refused = await connectRevoke(d, computer);
  assert.equal(refused.status, 502, await refused.clone().text());
  assert.equal((await grantOf(d)).revoked, false);
  assert.equal(await stateOf(d, computer), "active");
  assert.equal((await d.access(d.tokens.access_token)).status, 200);
});

test("with the pool up, revoking a device removes it at the pool before answering", async (t) => {
  const d = await device(t, false);
  const computer = await computerOf(d);
  const { id } = await grantOf(d);
  const asked = d.asked();
  const revoked = await d.f.raw("/native/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${d.tokens.access_token}` },
  });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.deepEqual(await revoked.json(), { revoked: true });
  assert.equal(d.asked(), asked + 1, "the pool was asked once");
  assert.equal(await stateOf(d, computer), "revoked");
  await assertEnded(d, id);
  assert.deepEqual(await pendingCleanups(d), [], "nothing waits for a retry");
});
