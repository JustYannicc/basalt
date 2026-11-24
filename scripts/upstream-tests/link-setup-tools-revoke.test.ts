// A computer set up with a link gets an ordinary tools key. Connect revokes it in three steps; when
// deleting the key fails, the pool row stays revoking and the key keeps working. The tools host's
// every-minute pass asks the pool for these rows and deletes their keys. Connect, the tools host
// and the pool are the real ones, the pool's control endpoint served over HTTP.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleSetup } from "../../src/setup/host.ts";
import type { StoredComputer } from "../../src/pool/computer-registry.ts";
import { pool } from "../../src/pool/test/computers.ts";
import { host, origin } from "./native-pool-device-fixture.ts";

type Host = Awaited<ReturnType<typeof host>>;
/** Rows one pass reads at most. */
const batch = 25;
interface Pass {
  tools?: { deleted: number; finished: number; unavailable: boolean };
}

const pass = async (h: Host) => (await h.f.api.retryNativeCleanups({})) as Pass;
/** Whether the tools service still accepts the key, as every tool call checks it. */
const works = async (h: Host, key: string) =>
  (await h.f.api.verifyApiKey({ body: { key } })).valid === true;
/** Connect's own setup routes, as the person's browser calls them. */
const browser = (h: Host, path: string, init: RequestInit, env = h.env) =>
  handleSetup(
    new Request(`${origin}${path}`, {
      ...init,
      headers: { cookie: h.f.cookies, origin, "content-type": "application/json" },
    }),
    env,
  );

/** A computer set up with a link through Connect, claimed, with its working tools key. */
async function linked(h: Host, name = "Laptop") {
  const created = await browser(h, "/setup/v1/links", {
    method: "POST",
    body: JSON.stringify({ intent: h.intent, name }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  const { computerId, link } = (await created.json()) as { computerId: string; link: string };
  const claimed = await browser(h, `${new URL(link).pathname}?format=json`, { method: "GET" });
  assert.equal(claimed.status, 200, await claimed.clone().text());
  const { credentials } = (await claimed.json()) as { credentials: { toolsToken: string } };
  assert.ok(await works(h, credentials.toolsToken));
  return { id: computerId, key: credentials.toolsToken };
}
/** Connect's revoke stops after the pool revoked the model key, as deleting the key fails. */
async function stuck(h: Host, computer: { id: string }) {
  const toolsDown = {
    ...h.env,
    TOOLS_SERVICE: {
      fetch: (request: Request) =>
        new URL(request.url).pathname.endsWith("/api-key/delete")
          ? Promise.resolve(Response.json({ code: "INTERNAL" }, { status: 503 }))
          : h.f.handler(request),
    },
  };
  const revoked = await browser(
    h,
    `/setup/v1/computers/${computer.id}?intent=${encodeURIComponent(h.intent)}`,
    { method: "DELETE" },
    toolsDown,
  );
  assert.equal(revoked.status, 502, await revoked.clone().text());
  assert.equal((await h.p.registry())[computer.id]?.state, "revoking");
}
test("a stuck revoke's tools key dies on the next pass, and the revoke finishes", async (t) => {
  const h = await host(t);
  const computer = await linked(h);
  await stuck(h, computer);
  assert.ok(await works(h, computer.key), "the revoke stopped part-way and its key still works");

  const result = await pass(h);
  assert.deepEqual(result.tools, { deleted: 1, finished: 1, unavailable: false });
  assert.equal(await works(h, computer.key), false, "its tools key is gone");
  // The pool's upkeep confirms Home's keys are revoked and finishes the row.
  await h.p.expire();
  assert.equal((await h.p.registry())[computer.id]?.state, "revoked");
  assert.deepEqual((await pass(h)).tools, { deleted: 0, finished: 0, unavailable: false });
});

test("a healthy computer's tools key is never deleted", async (t) => {
  const h = await host(t);
  const healthy = await linked(h, "Desk");
  const finished = await linked(h, "Old laptop");
  // Connect's revoke that finished all three steps.
  const done = await browser(
    h,
    `/setup/v1/computers/${finished.id}?intent=${encodeURIComponent(h.intent)}`,
    { method: "DELETE" },
  );
  assert.equal(done.status, 200, await done.clone().text());
  const left = await linked(h, "Lost laptop");
  await stuck(h, left);

  const result = await pass(h);
  assert.equal(result.tools?.deleted, 1);
  assert.equal(await works(h, left.key), false);
  assert.ok(await works(h, healthy.key), "the healthy computer keeps its tools");
  assert.equal((await h.p.registry())[healthy.id]?.state, "active");
});

test("while the pool is down tools keep working and the pass deletes nothing", async (t) => {
  const h = await host(t);
  const healthy = await linked(h, "Desk");
  const left = await linked(h, "Lost laptop");
  await stuck(h, left);
  h.fail();
  assert.ok(await works(h, healthy.key), "serving a tool call never asks the pool");

  const down = await pass(h);
  assert.deepEqual(down.tools, { deleted: 0, finished: 0, unavailable: true });
  assert.ok(await works(h, healthy.key));
  assert.ok(await works(h, left.key), "unknown never deletes; the next pass resumes");

  h.recover();
  assert.equal((await pass(h)).tools?.deleted, 1);
  assert.equal(await works(h, left.key), false);
  assert.ok(await works(h, healthy.key));
});

test("an answer the host can't read, or a key that isn't the person's, deletes nothing", async (t) => {
  const h = await host(t);
  const left = await linked(h, "Lost laptop");
  await stuck(h, left);
  const toolsKeyId = (await h.p.registry())[left.id]?.toolsKeyId;
  for (const answer of [
    () => new Response("<html>edge page</html>", { headers: { "content-type": "text/html" } }),
    () => Response.json({ computers: [{ computer: left.id, user: h.f.userId, toolsKeyId: 7 }] }),
    () => Response.json({ rows: [{ computer: left.id, user: h.f.userId, toolsKeyId }] }),
  ]) {
    h.answerWith(answer);
    assert.deepEqual((await pass(h)).tools, { deleted: 0, finished: 0, unavailable: true });
    assert.ok(await works(h, left.key));
  }
  h.answerWith();
  // A row naming another person can't delete this person's key.
  const registry = await h.p.registry();
  registry[left.id]!.user = "someone-else";
  await h.p.storage.put("computer-registry-v1", registry);
  assert.equal((await pass(h)).tools?.deleted, 0);
  assert.ok(await works(h, left.key));
});

test("a link-setup computer removed before the pool recorded why loses its key; one removed for access keeps it", async (t) => {
  const h = await host(t);
  const legacy = await linked(h, "Old laptop");
  const access = await linked(h, "Team laptop");
  const registry = await h.p.registry();
  const at = new Date(h.p.now()).toISOString();
  // An earlier release finished both as `removed`; only the second recorded that access ended it.
  Object.assign(registry[legacy.id]!, { state: "removed", removedAt: at });
  Object.assign(registry[access.id]!, { state: "removed", removedAt: at, removedFor: "access" });
  await h.p.storage.put("computer-registry-v1", registry);

  const result = await pass(h);
  assert.deepEqual(result.tools, { deleted: 1, finished: 1, unavailable: false });
  assert.equal(await works(h, legacy.key), false, "taken as its person's revoke");
  assert.ok(await works(h, access.key), "its tools are still its person's own");
});

test("a grant cleanup that keeps failing doesn't hold back a stuck revoke's key", async (t) => {
  const h = await host(t);
  const left = await linked(h, "Lost laptop");
  await stuck(h, left);
  // A live native grant the pass can't read fails its grant step on every pass.
  const at = new Date();
  await h.f.adapter.create({
    model: "mcpGrant",
    forceAllowId: true,
    data: {
      id: "native:unreadable",
      userId: h.f.userId,
      clientId: "",
      resource: `${origin}/native`,
      policy: "{}",
      revoked: false,
      createdAt: at,
      updatedAt: at,
    },
  });
  await assert.rejects(pass(h), "the grant step still reports its failure");
  assert.equal(await works(h, left.key), false, "the tools key was deleted all the same");
});

test("a pass makes the same few pool calls however many healthy keys exist", async (t) => {
  const h = await host(t);
  const registry = await h.p.registry();
  const at = new Date(h.p.now()).toISOString();
  const row = (id: string, state: StoredComputer["state"]): StoredComputer => ({
    id,
    name: "Laptop",
    user: h.f.userId,
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
  const asked = async () => {
    const before = h.asked();
    const result = await pass(h);
    return { calls: h.asked() - before, result };
  };
  for (let index = 0; index < 40; index++)
    registry[`left-${index}`] = row(`left-${index}`, "revoking");
  await h.p.storage.put("computer-registry-v1", registry);
  const few = await asked();
  assert.ok(few.calls <= 2, `${few.calls} pool calls`);
  assert.equal(few.result.tools?.finished, batch, "one batch a pass");

  const more = await h.p.registry();
  for (let index = 0; index < 2_000; index++)
    more[`healthy-${index}`] = row(`healthy-${index}`, "active");
  await h.p.storage.put("computer-registry-v1", more);
  const many = await asked();
  assert.equal(many.calls, few.calls, "healthy keys add no pool calls");
  assert.equal(many.result.tools?.finished, 40 - batch, "the next pass takes the rest");
  const idle = await asked();
  assert.equal(idle.calls, 1, "with nothing left, one read");
  assert.deepEqual(idle.result.tools, { deleted: 0, finished: 0, unavailable: false });
});
