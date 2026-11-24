import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, member } from "./test/computers.ts";

const laptop = { name: "Laptop", toolsKeyId: "tools-member", toolsToken: "fake-tools-member" };
function keyCalls(f: ReturnType<typeof fixture>, method: string) {
  const calls = f.server.calls.filter((call) => call.path === "/access/api-keys");
  return calls.filter((call) => call.method === method).length;
}

test("a web setup while the pool container is stopped fails retryably and leaves no issuing row", async () => {
  const f = fixture();
  const intent = await f.intent();
  f.server.stopped = true;
  const failed = await f.action("links", member, intent, laptop);
  assert.equal(failed.status, 503, await failed.clone().text());
  assert.equal(((await failed.json()) as { error: string }).error, "backend_unavailable");
  assert.deepEqual(await f.registry(), {});

  f.server.stopped = false;
  const retried = await f.action("links", member, intent, laptop);
  assert.equal(retried.status, 200, await retried.clone().text());
  const link = (await retried.json()) as { computer: { id: string }; token: string };
  const claimed = await f.action("claim", member, undefined, { token: link.token, format: "json" });
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const { credentials } = (await claimed.json()) as { credentials: { modelKey: string } };
  // Upkeep finishes the failed attempt and leaves the answered setup's key alone.
  await f.expire();
  const rows = Object.values(await f.registry());
  assert.deepEqual(
    rows.map((row) => [row.id, row.state]),
    [[link.computer.id, "active"]],
  );
  assert.deepEqual(
    f.server.keys.map((key) => [key.api_key_id, key.api_key]),
    [[rows[0]!.keyId, credentials.modelKey]],
  );
});

test("upkeep retries revoking a failed setup's key until Home answers, then stops", async (t) => {
  const f = fixture();
  const logged = t.mock.method(console, "error", () => {});
  const intent = await f.intent();
  f.server.mintReplyFailure = true;
  assert.equal((await f.action("links", member, intent, laptop)).status, 503);
  assert.deepEqual(await f.registry(), {});
  assert.equal(f.server.keys.length, 1);

  f.server.revokeFailure = true;
  await f.expire();
  assert.equal(f.server.keys.length, 1);
  assert.deepEqual(logged.mock.calls.at(-1)?.arguments, [
    "POOL_SETUP_KEY_CLEANUP_PENDING",
    { pending: 1 },
  ]);

  f.server.revokeFailure = false;
  await f.expire();
  assert.equal(f.server.keys.length, 0);
  const deletes = keyCalls(f, "DELETE");
  await f.expire();
  assert.equal(keyCalls(f, "DELETE"), deletes);
});

test("a setup whose object stopped mid-mint leaves no row, and upkeep checks Home once", async () => {
  const f = fixture();
  const intent = await f.intent();
  let reached!: () => void;
  const minting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  f.server.onMint = reached;
  // Home never answers this object: it stops while the key is being made.
  f.server.mintGate = new Promise<void>(() => {});
  void f.action("links", member, intent, laptop);
  await minting;
  f.restart();
  assert.deepEqual(await f.registry(), {});

  await f.expire();
  const reads = keyCalls(f, "GET");
  assert.ok(reads > 0);
  await f.expire();
  assert.equal(keyCalls(f, "GET"), reads);
});
