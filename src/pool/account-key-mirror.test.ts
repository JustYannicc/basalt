import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { accountMirrorPath, accountMirrorPrefix, handleAccountKeyMirror } from "./account-key-mirror.ts";
import { signEnvelope, signPoolToken } from "./token.ts";

const signingKey = "ab".repeat(32);
const reference = "12345678-abcd-4000-8000-000000000001";
const now = 1_800_000_000_000;
const request = async (value: object) => new Request(`https://pool.example${accountMirrorPath}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ envelope: await signEnvelope(signingKey, accountMirrorPrefix, { at: now, expiresAt: now + 10_000, reference, ...value }) }),
});

test("host mirror preserves the assigned Home UUID on retry and removes only that credential", async () => {
  const calls: { path: string; method: string; value: unknown }[] = [];
  let available = false;
  const home = new HomeClient(async (path, init) => {
    const value: unknown = init?.body === undefined ? null : JSON.parse(String(init.body));
    calls.push({ path, method: init?.method ?? "GET", value });
    if (init?.method === "DELETE") return new Response(null, { status: available ? (available = false, 204) : 404 });
    available = true;
    return Response.json({ name: `${reference}.json` });
  });
  const invoke = async (value: object) => handleAccountKeyMirror(await request(value), { home, signingKey, now: () => now });
  for (let attempt = 0; attempt < 2; attempt++)
    assert.equal((await invoke({ action: "upsert", credential: { type: "typesafe", token: "synthetic-key" } })).status, 200);
  assert.deepEqual(calls.map(c => c.value), [
    { type: "typesafe", token: "synthetic-key", uuid: reference },
    { type: "typesafe", token: "synthetic-key", uuid: reference },
  ]);
  assert.equal((await invoke({ action: "remove" })).status, 200);
  assert.equal((await invoke({ action: "remove" })).status, 200);
  assert.equal(calls.at(-1)?.path, `/v8/management/credentials?id=${reference}`);
});

test("ordinary pool tokens, expired assertions and identity overrides cannot reach Home", async () => {
  let calls = 0;
  const home = new HomeClient(async () => { calls++; return Response.json({}); });
  const invoke = async (value: object) => handleAccountKeyMirror(await request(value), { home, signingKey, now: () => now });
  assert.equal((await invoke({ action: "upsert", expiresAt: now, credential: { type: "typesafe", token: "synthetic" } })).status, 401);
  assert.equal((await invoke({ action: "upsert", credential: { type: "typesafe", uuid: reference, token: "synthetic" } })).status, 400);
  const ordinary = new Request(`https://pool.example${accountMirrorPath}`, { method: "POST", body: JSON.stringify({
    envelope: await signPoolToken(signingKey, { pool: "pool", owner: "owner", organization: "org" }),
  }) });
  assert.equal((await handleAccountKeyMirror(ordinary, { home, signingKey, now: () => now })).status, 401);
  assert.equal(calls, 0);
});

test("a Home response with a different identity never acknowledges a mirror", async () => {
  const home = new HomeClient(async () => Response.json({ name: "another-credential.json" }));
  assert.equal((await handleAccountKeyMirror(await request({ action: "upsert", credential: { type: "typesafe", token: "synthetic" } }),
    { home, signingKey, now: () => now })).status, 503);
});

test("oversized unsigned mirror bodies deliver at most one overflow byte before cancellation", async () => {
  let delivered = 0, cancelled = false, calls = 0;
  const stream = new ReadableStream({
    type: "bytes",
    pull(controller) {
      const view = controller.byobRequest?.view;
      if (view === null || view === undefined) {
        controller.enqueue(new Uint8Array(16_384));
        delivered += 16_384;
      } else {
        const size = Math.min(view.byteLength, 16_384);
        delivered += size;
        controller.byobRequest!.respond(size);
      }
    },
    cancel() { cancelled = true; },
  });
  const init = { method: "POST", body: stream, duplex: "half" };
  const incoming = new Request(`https://pool.example${accountMirrorPath}`, init);
  const home = new HomeClient(async () => { calls++; return Response.json({}); });
  assert.equal((await handleAccountKeyMirror(incoming, { home, signingKey })).status, 413);
  assert.equal(cancelled, true);
  assert.equal(delivered, 65_537);
  assert.equal(calls, 0);
});
