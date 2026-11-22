// A computer set up with a link keeps an ordinary tools-service key. When its person's revoke
// stops part-way, the tools host's every-minute pass reads these rows through the native control
// route, deletes their keys and reports them gone. Only the host's own control assertion may read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import { nativeControlPath, nativeControlPrefix, nativeModelPrefix } from "./native-contract.ts";
import { signEnvelope } from "./token.ts";

/** Rows one read returns at most. */
const toolsLeftoverBatch = 25;
type Pool = ReturnType<typeof fixture>;
interface Leftover {
  computer: string;
  user: string;
  toolsKeyId: string;
}

const post = (p: Pool, envelope: unknown) =>
  p.nativeControl(
    new Request(`https://pool.example${nativeControlPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
  );
/** The tools host's own control call. */
async function host(p: Pool, action: string, values: Record<string, unknown> = {}) {
  return post(
    p,
    await signEnvelope(signingKey, nativeControlPrefix, {
      ...values,
      action,
      expiresAt: p.now() + 10_000,
    }),
  );
}
async function leftovers(p: Pool) {
  const response = await host(p, "tools-leftovers");
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { computers: Leftover[] }).computers;
}
async function deleted(p: Pool, computers: { computer: string; toolsKeyId: string }[]) {
  const response = await host(p, "tools-deleted", { computers });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { finished: number }).finished;
}
/** A claimed computer set up with a link, with its own tools key. */
async function linked(p: Pool, toolsKeyId: string, user = member) {
  const intent = await p.intent(user);
  const response = await p.action("links", user, intent, {
    name: "Laptop",
    toolsKeyId,
    toolsToken: `token-${toolsKeyId}`,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { computer, token } = (await response.json()) as {
    computer: { id: string };
    token: string;
  };
  assert.equal((await p.action("claim", user, undefined, { token, format: "json" })).status, 200);
  return { id: computer.id, intent, user, toolsKeyId };
}
type Linked = Awaited<ReturnType<typeof linked>>;
const revoke = (p: Pool, c: Linked) => p.action("revoke", c.user, c.intent, { id: c.id });
const state = async (p: Pool, c: Linked) => (await p.registry())[c.id];

test("the host reads only link-setup computers whose person's revoke left a tools key", async () => {
  const p = fixture();
  const healthy = await linked(p, "key-healthy");
  // Step 1 of Connect's revoke failed at Home: the row stays `revoking`.
  const homeDown = await linked(p, "key-home-down");
  p.server.revokeFailure = true;
  assert.notEqual((await revoke(p, homeDown)).status, 200);
  p.server.revokeFailure = false;
  // Step 1 succeeded, then deleting the tools key failed: nobody asked for `revoked`.
  const toolsDown = await linked(p, "key-tools-down");
  assert.equal((await revoke(p, toolsDown)).status, 200);
  // All three steps succeeded: the setup host deleted the key before it asked for `revoked`.
  const finished = await linked(p, "key-finished");
  assert.equal((await revoke(p, finished)).status, 200);
  assert.equal(
    (await p.action("revoked", finished.user, finished.intent, { id: finished.id })).status,
    200,
  );
  const removed = await linked(p, "key-removed");
  const restored = await linked(p, "key-restored");
  const pending = await linked(p, "key-pending");
  const revokedInRemoval = await linked(p, "key-revoked-in-removal");
  const registry = await p.registry();
  // Access removal, not its person, ended this one; its tools are still the person's own.
  Object.assign(registry[removed.id]!, { state: "removed", removedFor: "access" });
  // Restored without history: its person may never have revoked it.
  Object.assign(registry[restored.id]!, { state: "revoking", restoredWithoutHistory: true });
  // Under access removal that began while it was active.
  Object.assign(registry[pending.id]!, {
    state: "revoking",
    removalPending: true,
    beforeRemoval: { state: "active" },
  });
  // Its person revoked it while access removal was pending, and removal then finished the row.
  Object.assign(registry[revokedInRemoval.id]!, { state: "removed", removedFor: "revoke" });
  await p.storage.put("computer-registry-v1", registry);

  const listed = await leftovers(p);
  assert.deepEqual(
    listed.map((row) => row.toolsKeyId).sort(),
    ["key-home-down", "key-revoked-in-removal", "key-tools-down"],
    "only rows its person revoked whose key may still work",
  );
  assert.deepEqual(
    listed.find((row) => row.toolsKeyId === "key-home-down"),
    { computer: homeDown.id, user: member, toolsKeyId: "key-home-down" },
  );
  assert.equal((await state(p, healthy))?.state, "active");
});

test("a report finishes a revoke once Home's keys are revoked too, never before", async () => {
  const p = fixture();
  const homeDown = await linked(p, "key-home-down");
  p.server.revokeFailure = true;
  assert.notEqual((await revoke(p, homeDown)).status, 200);
  p.server.revokeFailure = false;
  const keys = () => p.server.keys.length;
  const before = keys();

  assert.equal(await deleted(p, [{ computer: homeDown.id, toolsKeyId: "key-home-down" }]), 1);
  assert.deepEqual(await leftovers(p), [], "its tools key is no longer left behind");
  // Its model key may still be live, so it stays `revoking` for upkeep, which revokes it now.
  assert.equal((await state(p, homeDown))?.state, "revoking");
  await p.expire();
  assert.equal(keys(), before - 1, "upkeep revoked its model key at Home");
  const row = await state(p, homeDown);
  assert.equal(row?.state, "revoked", "and finished the revoke, with nothing left to wait for");
  assert.ok(row?.revokedAt);
});

test("a revoke upkeep already left waiting for its tools key finishes on the report", async () => {
  const p = fixture();
  const toolsDown = await linked(p, "key-tools-down");
  assert.equal((await revoke(p, toolsDown)).status, 200);
  await p.expire();
  assert.ok((await state(p, toolsDown))?.homeKeysRevokedAt, "upkeep revoked Home's keys");
  assert.equal((await state(p, toolsDown))?.state, "revoking");

  assert.equal(await deleted(p, [{ computer: toolsDown.id, toolsKeyId: "key-tools-down" }]), 1);
  assert.equal((await state(p, toolsDown))?.state, "revoked");
});

test("a report never finishes a row that isn't left behind, or names another key", async () => {
  const p = fixture();
  const healthy = await linked(p, "key-healthy");
  const toolsDown = await linked(p, "key-tools-down");
  assert.equal((await revoke(p, toolsDown)).status, 200);
  assert.equal(
    await deleted(p, [
      { computer: healthy.id, toolsKeyId: "key-healthy" },
      { computer: toolsDown.id, toolsKeyId: "key-other" },
      { computer: "missing", toolsKeyId: "key-missing" },
    ]),
    0,
  );
  assert.equal((await state(p, healthy))?.state, "active");
  assert.equal((await state(p, healthy))?.toolsKeyDeletedAt, undefined);
  assert.equal((await leftovers(p)).length, 1);
  const tooMany = Array.from({ length: toolsLeftoverBatch + 1 }, (_, index) => ({
    computer: `computer-${index}`,
    toolsKeyId: `key-${index}`,
  }));
  assert.equal((await host(p, "tools-deleted", { computers: tooMany })).status, 400);
});

test("one read returns at most a batch, however many computers the pool holds", async () => {
  const p = fixture();
  const at = new Date(p.now()).toISOString();
  const registry = await p.registry();
  const row = (id: string, state: "active" | "revoking") => ({
    id,
    name: "Laptop",
    user: member,
    pool: pool.pool,
    createdAt: at,
    boundAt: at,
    state,
    keyId: 1,
    toolsKeyId: `key-${id}`,
    toolsHash: "hash",
    firstModelRequestAt: null,
    firstToolCallAt: null,
    revokedAt: null,
  });
  for (let index = 0; index < 2_000; index++)
    registry[`healthy-${index}`] = row(`healthy-${index}`, "active");
  for (let index = 0; index < 40; index++)
    registry[`left-${index}`] = row(`left-${index}`, "revoking");
  await p.storage.put("computer-registry-v1", registry);

  const first = await leftovers(p);
  assert.equal(first.length, toolsLeftoverBatch);
  assert.ok(first.every((left) => left.computer.startsWith("left-")));
  assert.equal(await deleted(p, first), toolsLeftoverBatch);
  const second = await leftovers(p);
  assert.equal(second.length, 40 - toolsLeftoverBatch, "the next read takes the rest");
  assert.ok(second.every((left) => !first.some((done) => done.computer === left.computer)));
});

test("only the tools host's own control assertion reads anything, and others learn nothing", async () => {
  const p = fixture();
  const callers = async () => {
    const now = p.now();
    const claims = { action: "tools-leftovers", expiresAt: now + 10_000 };
    const responses = [
      await post(p, undefined),
      await post(p, "not-an-envelope"),
      // Another key, another prefix (the setup host's, a native model request's), a stale or
      // far-off expiry: each is someone other than the tools host's current control call.
      await post(p, await signEnvelope("ef".repeat(32), nativeControlPrefix, claims)),
      await post(p, await signEnvelope(signingKey, "sbs1", claims)),
      await post(p, await signEnvelope(signingKey, nativeModelPrefix, claims)),
      await post(
        p,
        await signEnvelope(signingKey, nativeControlPrefix, { ...claims, expiresAt: now - 1 }),
      ),
      await post(
        p,
        await signEnvelope(signingKey, nativeControlPrefix, { ...claims, expiresAt: now + 60_000 }),
      ),
      // The setup route signs as the setup host, even with a person's own intent.
      await p.action("tools-leftovers", owner, await p.intent(owner)),
    ];
    return Promise.all(
      responses.map(async (response) => `${response.status} ${await response.text()}`),
    );
  };
  const empty = await callers();
  const c = await linked(p, "key-secret");
  assert.equal((await revoke(p, c)).status, 200);
  const held = await callers();
  assert.deepEqual(held, empty, "the answer is the same whether or not a key is left");
  for (const answer of held) {
    assert.ok(!answer.startsWith("200"), answer);
    assert.ok(!answer.includes("key-secret") && !answer.includes(c.id), answer);
  }
  assert.deepEqual(
    (await leftovers(p)).map((row) => row.toolsKeyId),
    ["key-secret"],
    "the tools host itself reads it",
  );
});
