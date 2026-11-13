import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeActivity } from "./runtime-slots/activity.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import type { SlotIdentity } from "./runtime-slots/contract.ts";
import { LegacyActivity } from "./runtime-slots/legacy-activity.ts";

const identity: SlotIdentity = {
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "runtime-1",
  applicationId: "blue",
  applicationVersion: "1",
  instanceId: "runtime-1",
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "image-1",
  bootId: "boot-1",
};

test("pre-adoption request accounting survives reconstruction and duplicate completion", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const before = new LegacyActivity(storage);
  const complete = await before.acquire();
  assert.equal(await new LegacyActivity(storage).active(), 1);
  await Promise.all([complete(), complete()]);
  assert.equal(await new LegacyActivity(storage).active(), 0);
});

test("reconstruction cannot retire a live stream, and a drain fence excludes new admissions", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const first = new RuntimeActivity(storage);
  await first.initialize(identity, true);
  const releases = await Promise.all(Array.from({ length: 20 }, () => first.acquire(identity)));
  const reconstructed = new RuntimeActivity(storage);
  assert.deepEqual(await reconstructed.drain(identity), { active: 20, known: true });
  await assert.rejects(reconstructed.retire(identity), /draining/);
  await assert.rejects(first.acquire(identity), /draining/);
  await Promise.all(releases.map((release) => Promise.all([release(), release()])));
  assert.deepEqual(await reconstructed.drain(identity), { active: 0, known: true });
  await reconstructed.retire(identity);
  await assert.rejects(new RuntimeActivity(storage).retire(identity), /uncertain/);
});

test("untracked retained runtimes keep serving but require positive drain reconciliation", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  const release = await activity.acquire(identity);
  await release();
  await activity.initialize(identity, true);
  assert.deepEqual(await activity.drain(identity), { active: 0, known: false });
  await assert.rejects(activity.retire(identity), /draining/);
});

test("a lost acquisition acknowledgement stays counted and never fabricates a release", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  storage.afterCommit = () => {
    throw new Error("lost acknowledgement");
  };
  await assert.rejects(activity.acquire(identity), /lost acknowledgement/);
  storage.afterCommit = () => {};
  assert.deepEqual(await new RuntimeActivity(storage).drain(identity), { active: 1, known: true });
  await assert.rejects(activity.retire(identity), /draining/);
});

test("changed runtime identity cannot release or drain another runtime's activity", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  const replacement = { ...identity, instanceId: "other-runtime" };
  await assert.rejects(activity.acquire(replacement), /identity/);
  await assert.rejects(activity.drain(replacement), /identity/);
  await assert.rejects(activity.initialize(replacement, true), /identity/);
});

test("reusing a logical slot keeps an older boot's completion separate from its replacement", async (context) => {
  const storage = new RuntimeSqlite();
  context.after(() => storage.close());
  const activity = new RuntimeActivity(storage);
  await activity.initialize(identity, true);
  const oldRelease = await activity.acquire(identity);
  const replacement = { ...identity, bootId: "boot-2" };
  await activity.initialize(replacement, true);
  const newRelease = await activity.acquire(replacement);
  await oldRelease();
  assert.deepEqual(await activity.drain(identity), { active: 0, known: true });
  assert.deepEqual(await activity.drain(replacement), { active: 1, known: true });
  await activity.retire(identity);
  await assert.rejects(activity.retire(replacement), /draining/);
  await newRelease();
  await activity.retire(replacement);
});
