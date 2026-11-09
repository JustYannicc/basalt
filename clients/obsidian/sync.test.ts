import { decodeReceipt } from "./remote.ts";
import { decodeState } from "./state.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { storageFixture } from "../../src/drive/fixture.ts";
import { openVault } from "../../src/drive/vault.ts";
import { createSync } from "./sync.ts";
import type { LocalVault, RemoteVault, SyncState } from "./types.ts";

async function fixture(initial: Record<string, string>, stamped = false) {
  const data = storageFixture(),
    account = storageFixture();
  const cloud = await openVault({ ...data, accountStorage: account.storage, prefix: "plugin/" });
  const files = new Map(Object.entries(initial));
  let state: SyncState | null = null,
    listCalls = 0,
    readCalls = 0,
    localReads = 0,
    calls = 0,
    loseReply = false,
    revoked = false;
  const local: LocalVault = {
    binary: true,
    files: async () =>
      [...files].map(([path, text]) => ({
        path,
        bytes: new TextEncoder().encode(text).length,
        ...(stamped ? { stamp: text } : {}),
      })),
    read: async (path) => {
      localReads++;
      return files.get(path) ?? null;
    },
    replace: async (path, expected, content) => {
      if ((files.get(path) ?? null) !== expected) return false;
      if (content === null) files.delete(path);
      else files.set(path, content);
      return true;
    },
  };
  const remote: RemoteVault = {
    ...cloud.service,
    list: async (input = {}) => {
      listCalls++;
      return cloud.service.list(input);
    },
    read: async (input) => {
      readCalls++;
      return cloud.service.read(input);
    },
    receipt: (operation) => cloud.service.receipt({ operation }),
    resolve: async (input) => decodeReceipt(await cloud.service.resolve(input)),
    apply: async (input) => {
      if (revoked) throw new Error("Device access removed");
      calls++;
      const result = decodeReceipt(await cloud.service.apply(input));
      if (loseReply) {
        loseReply = false;
        throw new Error("Reply lost");
      }
      return result;
    },
  };
  const store = {
    load: async () => decodeState(structuredClone(state)),
    save: async (value: SyncState) => {
      state = structuredClone(value);
    },
  };
  const sync = () => createSync({ local, remote, store, id: () => crypto.randomUUID() });
  return {
    cloud,
    files,
    remote,
    store,
    sync,
    failReply: () => {
      loseReply = true;
    },
    revoke: () => {
      revoked = true;
    },
    reconnect: () => {
      revoked = false;
    },
    calls: () => calls,
    listCalls: () => listCalls,
    readCalls: () => readCalls,
    localReads: () => localReads,
    state: () => state,
    close() {
      data.close();
      account.close();
    },
  };
}
test("an interrupted import resumes its exact operation after restart and resends no acknowledged file bodies", async () => {
  const f = await fixture({ "one.md": "one", "two.md": "two" });
  try {
    f.failReply();
    const first = await f.sync();
    await assert.rejects(first.run(), /Reply lost/);
    assert.ok(f.state()?.pending);
    assert.equal(f.calls(), 1);
    const restarted = await f.sync();
    await restarted.run();
    assert.equal(f.calls(), 1);
    assert.equal(f.state()?.pending, null);
    assert.equal((await f.cloud.service.read({ path: "two.md" }))?.content, "two");
    await restarted.run();
    assert.equal(f.calls(), 1);
    assert.equal(restarted.status().state, "idle");
  } finally {
    f.close();
  }
});

test("unchanged local stamps skip note reads, edits invalidate them and a restart rereads", async () => {
  const f = await fixture({ "one.md": "one", "two.md": "two" }, true);
  try {
    const sync = await f.sync();
    await sync.run();
    const reads = f.localReads();
    await sync.run();
    assert.equal(f.localReads(), reads);
    f.files.set("one.md", "new");
    await sync.run();
    assert.equal((await f.cloud.service.read({ path: "one.md" }))?.content, "new");
    const changedReads = f.localReads();
    await sync.run();
    assert.equal(f.localReads(), changedReads);
    await (await f.sync()).run();
    assert.ok(f.localReads() >= changedReads + 2);
  } finally {
    f.close();
  }
});

test("paths matching JavaScript prototype properties survive save, restart, edit and delete", async () => {
  const f = await fixture(
    Object.fromEntries([
      ["__proto__", "first"],
      ["constructor", "second"],
    ]),
  );
  try {
    await (await f.sync()).run();
    const sync = await f.sync();
    f.files.set("__proto__", "changed");
    f.files.delete("constructor");
    await sync.run();
    assert.equal((await f.cloud.service.read({ path: "__proto__" }))?.content, "changed");
    assert.equal(await f.cloud.service.read({ path: "constructor" }), null);
    assert.equal(sync.status().state, "idle");
  } finally {
    f.close();
  }
});
test("offline edits survive restart and same-hunk cloud edits remain on a visible conflict branch", async () => {
  const f = await fixture({ "same.md": "base\n" });
  try {
    await (await f.sync()).run();
    const base = (await f.cloud.service.list()).at;
    f.files.set("same.md", "phone\n");
    f.revoke();
    await assert.rejects((await f.sync()).run(), /access removed/);
    assert.ok(f.state()?.pending);
    await f.cloud.service.write({
      base,
      path: "same.md",
      content: "agent\n",
      operation: "agent",
      mode: "edit",
    });
    f.reconnect();
    const restarted = await f.sync();
    await restarted.run();
    assert.equal(restarted.status().state, "conflict");
    assert.equal(f.files.get("same.md"), "phone\n");
    assert.equal((await f.cloud.service.read({ path: "same.md" }))?.content, "agent\n");
    assert.equal(f.state()?.conflicts.length, 1);
    const conflict = f.state()!.conflicts[0]!;
    assert.equal(
      (await f.cloud.service.read({ path: "same.md", at: conflict.oid }))?.content,
      "phone\n",
    );
    const { conflictSides } = await import("./conflict-sides.ts");
    const sides = conflictSides(conflict.conflicts[0]!);
    assert.equal(
      (await f.cloud.service.read({ path: "same.md", at: sides.deviceAt }))?.content,
      "phone\n",
    );
    assert.equal(
      (await f.cloud.service.read({ path: "same.md", at: sides.cloudAt }))?.content,
      "agent\n",
    );
    await restarted.resolve(conflict.ref, [{ path: "same.md", content: "both\n" }]);
    assert.equal(f.files.get("same.md"), "both\n");
    assert.equal(restarted.status().state, "idle");
  } finally {
    f.close();
  }
});
test("a resumed no-change import never treats unimported cloud notes as local deletions", async () => {
  const f = await fixture({ "local.md": "local" });
  try {
    await f.cloud.service.write({
      base: f.cloud.root,
      path: "cloud.md",
      content: "cloud",
      operation: "seed",
      mode: "create",
    });
    const sync = await f.sync();
    await sync.run();
    assert.equal(f.files.get("cloud.md"), "cloud");
    f.files.delete("local.md");
    await sync.run();
    assert.equal(await f.cloud.service.read({ path: "local.md" }), null);
    assert.equal(f.files.get("cloud.md"), "cloud");
    assert.ok((await f.cloud.service.history()).length >= 3);
  } finally {
    f.close();
  }
});
test("a local edit during a cloud download is never overwritten", async () => {
  const f = await fixture({ "race.md": "base\n" });
  try {
    const sync = await f.sync();
    await sync.run();
    const base = (await f.cloud.service.list()).at;
    await f.cloud.service.write({
      base,
      path: "race.md",
      content: "cloud\n",
      operation: "cloud-edit",
      mode: "edit",
    });
    const read = f.remote.read;
    let raced = false;
    f.remote.read = async (input) => {
      const page = await read(input);
      if (!raced) {
        raced = true;
        f.files.set("race.md", "new local edit\n");
      }
      return page;
    };
    await sync.run();
    assert.equal(f.files.get("race.md"), "new local edit\n");
    assert.equal((await f.cloud.service.read({ path: "race.md" }))?.content, "cloud\n");
    await sync.run();
    assert.equal(sync.status().state, "conflict");
    assert.equal(f.files.get("race.md"), "new local edit\n");
  } finally {
    f.close();
  }
});
test("an import spanning batches keeps batching after the first receipt and sends zero bodies on a second import", async () => {
  const f = await fixture(
    Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`folder/${i}.md`, `note ${i}`])),
  );
  try {
    const sync = await f.sync();
    await sync.run();
    assert.equal(f.calls(), 2);
    assert.equal(f.files.size, 105);
    await (await f.sync()).run();
    assert.equal(f.calls(), 2);
  } finally {
    f.close();
  }
});
test("suspending after a committed upload stops the next batch and resumes from its receipt", async () => {
  const f = await fixture(
    Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`folder/${i}.md`, `note ${i}`])),
  );
  try {
    const stop = new AbortController(),
      original = f.remote.apply;
    f.remote.apply = async (request) => {
      const result = await original(request);
      stop.abort();
      return result;
    };
    const suspended = await createSync({
      local: {
        files: async () => [...f.files].map(([path, text]) => ({ path, bytes: text.length })),
        read: async (path) => f.files.get(path) ?? null,
        replace: async (path, expected, content) => {
          if ((f.files.get(path) ?? null) !== expected) return false;
          if (content === null) f.files.delete(path);
          else f.files.set(path, content);
          return true;
        },
      },
      remote: f.remote,
      store: f.store,
      id: () => crypto.randomUUID(),
      signal: stop.signal,
    });
    await assert.rejects(suspended.run(), /abort/iu);
    assert.equal(f.calls(), 1);
    assert.ok(f.state()?.pending);
    f.remote.apply = original;
    await (await f.sync()).run();
    assert.equal(f.calls(), 2);
    assert.equal(f.state()?.pending, null);
  } finally {
    f.close();
  }
});

test("an unchanged sync uses one head read and no full cloud walk or note download", async () => {
  const f = await fixture({ "one.md": "one", "nested/two.md": "two" });
  try {
    const sync = await f.sync();
    await sync.run();
    const before = { lists: f.listCalls(), reads: f.readCalls() };
    await sync.run();
    assert.equal(f.listCalls() - before.lists, 1);
    assert.equal(f.readCalls() - before.reads, 0);
    const at = (await f.cloud.service.list()).at;
    await f.cloud.service.write({
      base: at,
      path: "nested/two.md",
      content: "agent",
      mode: "edit",
      operation: "changed",
    });
    const lists = f.listCalls();
    await sync.run();
    assert.equal(f.listCalls() - lists, 1);
    assert.equal(f.files.get("nested/two.md"), "agent");
    assert.equal(f.files.get("one.md"), "one");
  } finally {
    f.close();
  }
});

test("first import keeps a local note and an existing different cloud note on separate conflict branches", async () => {
  const f = await fixture({ "same.md": "local import" });
  try {
    await f.cloud.service.write({
      base: f.cloud.root,
      path: "same.md",
      content: "existing cloud",
      mode: "create",
      operation: "cloud-first",
    });
    const sync = await f.sync();
    await sync.run();
    assert.equal(sync.status().state, "conflict");
    assert.equal(f.files.get("same.md"), "local import");
    assert.equal((await f.cloud.service.read({ path: "same.md" }))?.content, "existing cloud");
    assert.equal(
      (await f.cloud.service.read({ path: "same.md", at: sync.conflicts()[0]!.oid }))?.content,
      "local import",
    );
  } finally {
    f.close();
  }
});

test("an idle visible vault receives cloud-only changes on its remote wake and stops after unload", async () => {
  const { watchRemoteChanges } = await import("./remote-wake.ts");
  const f = await fixture({ "idle.md": "before" });
  try {
    const sync = await f.sync();
    await sync.run();
    let visible = true,
      callback = () => {},
      stopped = false;
    const work: Promise<void>[] = [];
    const stop = watchRemoteChanges({
      repeat: (run, milliseconds) => {
        assert.ok(milliseconds >= 30000);
        callback = () => {
          if (!stopped) run();
        };
        return () => {
          stopped = true;
        };
      },
      available: () => visible,
      sync: () => {
        work.push(sync.run());
      },
    });
    await f.cloud.service.write({
      base: (await f.cloud.service.list()).at,
      path: "idle.md",
      content: "agent edited",
      mode: "edit",
      operation: "agent-idle-edit",
    });
    visible = false;
    callback();
    await Promise.all(work);
    assert.equal(f.files.get("idle.md"), "before");
    visible = true;
    callback();
    await Promise.all(work);
    assert.equal(f.files.get("idle.md"), "agent edited");
    stop();
    callback();
    assert.equal(work.length, 1);
  } finally {
    f.close();
  }
});
