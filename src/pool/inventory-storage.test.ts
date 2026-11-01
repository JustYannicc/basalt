import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inventoryRecord } from "./inventory-record.ts";
import { poolStorageSnapshot } from "./inventory-storage.ts";

test("storage projection preserves key bindings and drops sessions, ciphertext and labels", () => {
  const report = poolStorageSnapshot(new Map<string, unknown>([
    ["computer-registry-v1", { one: { id: "computer", name: "SYNTHETIC_LABEL", user: "person", pool: "app", state: "active",
      keyId: 7, userId: 9, toolsKeyId: "account", toolsHash: "SYNTHETIC_HASH", link: { encrypted: "SYNTHETIC_CIPHER" } } }],
    ["pool-directory-v1", { pools: { one: { pool: "app", owner: "person", organization: "org", name: "SYNTHETIC_NAME", users: ["person"], pending: [] } } }],
    ["pool-control-v1", { assigned: ["auth-id"], locks: { codex: { pool: "app", snapshot: ["auth-id"], state: "SYNTHETIC_SESSION" } },
      sessions: { SYNTHETIC_TOKEN: { session: { pool: "app", provider: "codex", state: "SYNTHETIC_SESSION" }, accountId: "auth-id" } } }],
  ]));
  assert.equal(report.computers?.[0]?.keyId, 7);
  assert.equal(report.attribution?.sessions[0]?.accountId, "auth-id");
  assert.equal(report.attribution?.locks[0]?.snapshot[0], "auth-id");
  assert.equal(JSON.stringify(report).includes("SYNTHETIC"), false);
  assert.deepEqual(report.absentKeys, []);
  assert.deepEqual(poolStorageSnapshot(new Map()).absentKeys, ["computer-registry-v1", "pool-directory-v1", "pool-control-v1"]);
});

test("private report parts reconstruct the exact hashed snapshot and never grant data GO", () => {
  const records: string[] = [];
  const original = console.info;
  console.info = (line: string) => records.push(line);
  const report = { ids: Array.from({ length: 1_000 }, (_, index) => `synthetic-${index}`) };
  try { inventoryRecord("pool-v1", report, ["fixture"]); }
  finally { console.info = original; }
  const parts = records.map((record) => JSON.parse(record));
  const end = parts.pop();
  assert.ok(parts.length > 1);
  const json = parts.map((part, index) => {
    assert.equal(part.index, index);
    assert.equal(part.run, end.run);
    return part.data;
  }).join("");
  assert.deepEqual(JSON.parse(json), report);
  assert.equal(end.chunks, parts.length);
  assert.equal(end.bytes, Buffer.byteLength(json));
  assert.equal(end.sha256, createHash("sha256").update(json).digest("hex"));
  assert.equal(end.migrationGo, false);
});

test("models-only computer inventory keeps its model key without inventing a tools key", () => {
  const report = poolStorageSnapshot(new Map<string, unknown>([
    ["computer-registry-v1", { one: { id: "models-only", user: "person", pool: "app", state: "active", keyId: 7, userId: 9 } }],
  ]));
  assert.deepEqual(report.computers, [{ id: "models-only", user: "person", pool: "app", state: "active", keyId: 7,
    userId: 9, toolsKeyId: null, switching: [], switchingTo: null }]);
});
