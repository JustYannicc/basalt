import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { CommittedRevision } from "../../.upstream/packages/app-data/src/contracts/change-revisions.ts";
import { makeRevisionFence } from "../../.upstream/packages/apps/src/implementation/revision-fence.ts";

const key = { topic: "deployment", resource: "app-a" };
const revision = (value: string) => ({ ...key, revision: value });

test("revision counters stay exact beyond JavaScript's integer range and reject invalid wire values", () => {
  const fence = makeRevisionFence("server/team/viewer/session/app", [key]);
  const connection = fence.begin();
  assert.equal(fence.handshake(connection, [revision("9007199254740992")]), true);
  fence.acknowledge(revision("9007199254740993"));
  assert.equal(fence.accept(connection, [revision("9007199254740992")]), false);
  assert.equal(fence.accept(connection, [revision("9007199254740993")]), true);
  for (const value of ["-1", "1.5", "NaN", "01", "9223372036854775808", 1]) {
    assert.equal(Schema.decodeUnknownOption(CommittedRevision)(value)._tag, "None");
  }
});

test("an older in-flight response cannot win against a newer acknowledged revision", async () => {
  const fence = makeRevisionFence("server/team/viewer/session/app", [key]);
  const connection = fence.begin();
  assert.equal(fence.handshake(connection, [revision("1")]), true);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const oldResponse = held.then(() => fence.accept(connection, [revision("1")]));
  fence.acknowledge(revision("2"));
  release();
  assert.equal(await oldResponse, false);
  assert.equal(fence.accept(connection, [revision("2")]), true);
});

test("disconnect invalidates old responses and reconnect must reconcile every required key", () => {
  const fence = makeRevisionFence("server/team/viewer/session/app", [key]);
  const first = fence.begin();
  assert.equal(fence.handshake(first, [revision("1")]), true);
  fence.disconnect();
  assert.equal(fence.accept(first, [revision("1")]), false);
  const next = fence.begin();
  assert.equal(fence.accept(next, [revision("2")]), false);
  assert.equal(fence.handshake(next, []), false);
  assert.equal(fence.handshake(next, [revision("2")]), true);
  assert.equal(fence.accept(first, [revision("3")]), false);
  assert.equal(fence.accept(next, [revision("1")]), false);
});
