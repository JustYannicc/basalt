// The native access check reuses a device's allowed answer for a few seconds. A tools-only grant's
// check asks the pool nothing, and a revoked device's pool cleanup can wait for an outage, so a
// revoke on this host forgets the grant's remembered answers itself: the device's next check
// reads its rows again and is refused. The host and pool are the real code, as in
// native-revoke-pool-outage.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { recentAnswers } from "../../.upstream/packages/mcp-auth/src/implementation/native-access-memory.ts";
import { device } from "./native-pool-device-fixture.ts";

type Device = Awaited<ReturnType<typeof device>>;

/** A check the device's next request would make within the bound, which remembers its answer. */
async function remembered(d: Device) {
  const allowed = await d.access(d.tokens.access_token);
  assert.equal(allowed.status, 200, await allowed.clone().text());
}

test("a tools-only device that signs itself out is refused on its very next check", async (t) => {
  const d = await device(t, false);
  await remembered(d);
  const out = await d.signOut(d.tokens.access_token);
  assert.equal(out.status, 200, await out.clone().text());
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
});

test("a tools-only device revoked on Connect is refused on its very next check", async (t) => {
  const d = await device(t, false);
  const [computer] = Object.keys(await d.p.registry());
  assert.ok(computer, "the approval registered a computer at the pool");
  await remembered(d);
  const removed = await d.connect(`/${computer}`, "DELETE");
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
});

test("a models device revoked while its pool is down is refused once the pool answers again", async (t) => {
  const d = await device(t, true);
  await remembered(d);
  d.fail();
  const out = await d.signOut(d.tokens.access_token);
  assert.equal(out.status, 200, await out.clone().text());
  // The pool never heard of the revoke, so its device check would still admit the device.
  d.recover();
  assert.equal((await d.access(d.tokens.access_token)).status, 401);
});

test("an answer whose rows were read before its grant was forgotten is never kept", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const answers = recentAnswers<{ readonly grant: string }>((answer) => answer.grant);
  const readAt = Date.now();
  const deadline = readAt + 60_000;
  answers.set("one", { grant: "native:revoked" }, deadline, readAt);
  answers.set("other", { grant: "native:live" }, deadline, readAt);
  t.mock.timers.tick(10);
  answers.forget("native:revoked", Date.now());
  assert.equal(answers.get("one"), undefined);
  assert.deepEqual(answers.get("other"), { grant: "native:live" }, "another grant keeps it");
  // A check that read the grant's rows before the revoke and finishes after it.
  answers.set("two", { grant: "native:revoked" }, deadline, readAt + 10);
  assert.equal(answers.get("two"), undefined);
});
