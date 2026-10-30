import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { enableNewCodexWebSockets, migrateCodexWebSockets } from "./codex-websockets.ts";

function fixture() {
  const files = [
    { id: "codex-new", provider: "codex", websockets: false },
    { id: "codex-ready", provider: "codex", websockets: true },
    { id: "other", provider: "claude", websockets: false },
  ];
  const writes: unknown[] = [];
  let save = true;
  const client = new HomeClient(async (path, init) => {
    if (path === "/v8/management/credentials") return Response.json({ files });
    assert.equal(path, "/v8/management/credentials/fields");
    assert.equal(init?.method, "PATCH");
    const body = JSON.parse(String(init?.body));
    writes.push(body);
    if (save) files.find((file) => file.id === body.id)!.websockets = body.websockets;
    return Response.json({ status: "ok" });
  });
  return { client, files, writes, refuseSave: () => { save = false; } };
}

test("new Codex credentials enable and read back WebSockets without changing other providers", async () => {
  const f = fixture();
  await enableNewCodexWebSockets(f.client, ["codex-new"], "codex");
  await enableNewCodexWebSockets(f.client, ["codex-new"], "codex");
  await enableNewCodexWebSockets(f.client, ["other"], "claude");
  assert.deepEqual(f.writes, [{ id: "codex-new", websockets: true }]);
  assert.equal(f.files[2]!.websockets, false);
  await assert.rejects(enableNewCodexWebSockets(f.client, ["other"], "codex"));
});

test("a successful field-patch response without a true readback cannot complete setup", async () => {
  const f = fixture();
  f.refuseSave();
  await assert.rejects(enableNewCodexWebSockets(f.client, ["codex-new"], "codex"));
});

test("existing-credential migration dry run has counts only and GO binds the exact pending set", async () => {
  const f = fixture();
  const plan = await migrateCodexWebSockets(f.client);
  assert.equal(plan.status, "dry-run");
  assert.deepEqual([plan.total, plan.enabled, plan.pending, plan.applied], [2, 1, 1, 0]);
  assert.equal(JSON.stringify(plan).includes("codex-new"), false);
  assert.equal(f.writes.length, 0);
  await assert.rejects(migrateCodexWebSockets(f.client, { ...plan, digest: "stale" }));
  await assert.rejects(migrateCodexWebSockets(f.client, { ...plan, pending: 2 }));
  assert.equal(f.writes.length, 0);
  const applied = await migrateCodexWebSockets(f.client, plan);
  assert.equal(applied.status, "complete");
  assert.equal(applied.applied, 1);
  assert.deepEqual(f.writes, [{ id: "codex-new", websockets: true }]);
  // Replaying an old GO cannot silently operate on a changed selection.
  await assert.rejects(migrateCodexWebSockets(f.client, plan));
});

test("migration stops at the first unconfirmed readback and refuses an oversized pass", async () => {
  const f = fixture();
  f.refuseSave();
  const plan = await migrateCodexWebSockets(f.client);
  assert.equal((await migrateCodexWebSockets(f.client, plan)).status, "incomplete");
  assert.equal(f.writes.length, 1);
  f.files.push(...Array.from({ length: 50 }, (_, i) => ({ id: `codex-${i}`, provider: "codex", websockets: false })));
  const large = await migrateCodexWebSockets(f.client);
  assert.equal(large.pending, 51);
  await assert.rejects(migrateCodexWebSockets(f.client, large));
  assert.equal(f.writes.length, 1);
});
