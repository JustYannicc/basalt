import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SlotRefused } from "./runtime-slots/contract.ts";
import type { SlotStorage, TransactionStorage } from "./runtime-slots/storage.ts";
import {
  bookmarkRetentionMs,
  StorageBookmarks,
  storageRestoreNonceKey,
  type StorageRestoreCommand,
} from "./storage-bookmark.ts";

const code = { candidate: "a".repeat(40), workerInput: "b".repeat(64) };
/** Same shape as a platform bookmark, ordered by `position`. */
const mark = (position: number) =>
  `${position.toString(16).padStart(8, "0")}-00000000-00000000-${"c".repeat(32)}`;

function fixture(context: TestContext, shared?: Map<string, unknown>) {
  const values = shared ?? new Map<string, unknown>();
  const slots: SlotStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => {
      values.set(key, value);
    },
  };
  const storage: TransactionStorage = { ...slots, transaction: (work) => work(slots) };
  const state = { now: 1_800_000_000_000, live: 20, undo: mark(900), fail: false };
  const calls: string[] = [];
  const deferred: (() => void)[] = [];
  const logs = context.mock.method(console, "info", () => {});
  const bookmarks = new StorageBookmarks({
    storage,
    now: () => state.now,
    afterReply: (work) => {
      deferred.push(work);
    },
    port: {
      current: async () => mark(state.live),
      forTime: async (at) => {
        calls.push(`time:${at}`);
        return mark(5);
      },
      restoreOnNextSession: async (bookmark) => {
        calls.push(`restore:${bookmark}`);
        if (state.fail) throw new Error("synthetic platform refusal");
        return state.undo;
      },
      abort: () => {
        calls.push("abort");
      },
    },
  });
  const command = (fields: Partial<StorageRestoreCommand> = {}): StorageRestoreCommand => ({
    controllerCode: code,
    action: "storage-restore-bookmark",
    target: mark(10),
    expectedCurrent: mark(20),
    nonce: "restore-nonce-1",
    operator: "fixture-operator",
    at: state.now,
    expiresAt: state.now + 30_000,
    ...fields,
  });
  return { bookmarks, values, state, calls, deferred, logs, command };
}

const refused = (reason: SlotRefused["reason"]) => (error: unknown) =>
  error instanceof SlotRefused && error.reason === reason;

test("the bookmark read returns the current point and the server time", async (context) => {
  const { bookmarks, state } = fixture(context);
  assert.deepEqual(await bookmarks.read(), {
    bookmark: mark(20),
    at: new Date(state.now).toISOString(),
  });
});

test("the bookmark read resolves a time inside the 30 day window only", async (context) => {
  const { bookmarks, state, calls } = fixture(context);
  const at = state.now - 3_600_000;
  assert.deepEqual(await bookmarks.read(new Date(at).toISOString()), {
    bookmark: mark(5),
    at: new Date(at).toISOString(),
  });
  assert.deepEqual(calls, [`time:${at}`]);
  for (const time of [state.now + 1, state.now - bookmarkRetentionMs - 1])
    await assert.rejects(bookmarks.read(new Date(time).toISOString()), refused("selection"));
  assert.deepEqual(calls, [`time:${at}`]);
});

test("a restore schedules the target, replies with the undo bookmark, then ends the session", async (context) => {
  const { bookmarks, state, calls, deferred, logs, values, command } = fixture(context);
  await bookmarks.read();
  state.live = 23; // The object kept writing after the read. That alone must not refuse.
  const receipt = await bookmarks.restore(command());
  assert.deepEqual(receipt, { target: mark(10), live: mark(23), undo: mark(900) });
  assert.deepEqual(calls, [`restore:${mark(10)}`], "the session must outlive the reply");
  assert.equal(deferred.length, 1);
  deferred[0]!();
  assert.deepEqual(calls, [`restore:${mark(10)}`, "abort"]);
  assert.ok(values.get(storageRestoreNonceKey("restore-nonce-1")));
  const audit = logs.mock.calls.find((call) => call.arguments[0] === "POOL_STORAGE_RESTORE");
  assert.deepEqual(JSON.parse(String(audit?.arguments[1])), {
    nonce: "restore-nonce-1",
    operator: "fixture-operator",
    target: mark(10),
    expectedCurrent: mark(20),
    live: mark(23),
    undo: mark(900),
  });
});

test("a replayed nonce cannot restore twice in the same session", async (context) => {
  const { bookmarks, calls, command } = fixture(context);
  await bookmarks.read();
  await bookmarks.restore(command());
  await bookmarks.read();
  await assert.rejects(bookmarks.restore(command()), refused("selection"));
  assert.deepEqual(calls, [`restore:${mark(10)}`]);
});

test("the same envelope cannot restore again after the restore rolled its nonce back", async (context) => {
  const first = fixture(context);
  await first.bookmarks.read();
  const envelope = first.command();
  await first.bookmarks.restore(envelope);
  // The restored storage is older than the nonce, and the next session starts past the undo point.
  const next = fixture(context, new Map());
  next.state.live = 901;
  await assert.rejects(next.bookmarks.restore(envelope), refused("identity"));
  await next.bookmarks.read();
  await assert.rejects(next.bookmarks.restore(envelope), refused("identity"));
  assert.deepEqual(next.calls, []);
  assert.equal(next.deferred.length, 0);
});

test("a second envelope signed against the same read dies with the first restore", async (context) => {
  const { bookmarks, calls, command } = fixture(context);
  await bookmarks.read();
  await bookmarks.restore(command());
  await assert.rejects(
    bookmarks.restore(command({ nonce: "restore-nonce-2", target: mark(11) })),
    refused("identity"),
  );
  assert.deepEqual(calls, [`restore:${mark(10)}`]);
});

test("a restore is refused unless this session handed out the expected current bookmark", async (context) => {
  const { bookmarks, state, calls, deferred, command } = fixture(context);
  await assert.rejects(bookmarks.restore(command()), refused("identity"));
  await bookmarks.read();
  for (const fields of [
    { expectedCurrent: mark(19) },
    { expectedCurrent: mark(21) },
    { target: mark(20) },
    { target: mark(21) },
  ])
    await assert.rejects(bookmarks.restore(command(fields)), refused("identity"));
  state.live = 19; // The live point is behind what the caller saw: not this object's timeline.
  await assert.rejects(bookmarks.restore(command()), refused("identity"));
  assert.deepEqual(calls, []);
  assert.equal(deferred.length, 0);
});

test("a stale or overlong restore envelope is refused", async (context) => {
  const { bookmarks, state, calls, values, command } = fixture(context);
  await bookmarks.read();
  for (const times of [
    { at: state.now - 30_001, expiresAt: state.now - 1 },
    { at: state.now, expiresAt: state.now + 30_001 },
    { at: state.now + 5_001, expiresAt: state.now + 20_000 },
    { at: state.now, expiresAt: state.now },
  ])
    await assert.rejects(bookmarks.restore(command(times)), refused("identity"));
  assert.deepEqual(calls, []);
  assert.equal(values.size, 0);
});

test("a platform refusal consumes the nonce and leaves the session running", async (context) => {
  const { bookmarks, state, calls, deferred, command } = fixture(context);
  await bookmarks.read();
  state.fail = true;
  await assert.rejects(bookmarks.restore(command()), /synthetic platform refusal/u);
  assert.deepEqual(calls, [`restore:${mark(10)}`]);
  assert.equal(deferred.length, 0);
  state.fail = false;
  await assert.rejects(bookmarks.restore(command()), refused("selection"));
  await bookmarks.restore(command({ nonce: "restore-nonce-2" }));
  assert.deepEqual(calls, [`restore:${mark(10)}`, `restore:${mark(10)}`]);
});
