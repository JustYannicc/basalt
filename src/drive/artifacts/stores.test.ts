// Artifacts has no local emulator (miniflare's binding is remote-only), so the stand-in is real
// `git http-backend` over a bare repository, with `git cat-file` as the binding's readBlob.
import assert from "node:assert/strict";
import { test } from "node:test";
import { backend, git } from "./test/backend.ts";
import { device, remoteMain, repository, type Backend } from "./test/vault.ts";
import { storageFixture } from "../fixture.ts";
import { openVault } from "../vault.ts";
import type { VaultRepository } from "./stores.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Refuse the next `times` pushes on the server itself, so the ref really stays put, and reword
 * the report so the client sees a reason it has never seen.
 */
const refuseNextPush = (server: Backend, reason: string, times = 1) => {
  const hooks = join(server.bare, "hooks"),
    counter = join(server.root, "refusals");
  writeFileSync(counter, String(times));
  writeFileSync(
    join(hooks, "pre-receive"),
    `#!/bin/sh\nleft=$(cat "${counter}")\n[ "$left" -le 0 ] && exit 0\necho $((left - 1)) > "${counter}"\nexit 1\n`,
    { mode: 0o755 },
  );
  server.control.transform = (path, body) =>
    path.endsWith("git-receive-pack")
      ? Buffer.from(
          body
            .toString("latin1")
            .replace(/ng refs\/heads\/main [^\n]*/, `ng refs/heads/main ${reason}`),
          "latin1",
        )
      : body;
  return () => {
    writeFileSync(counter, "0");
    server.control.transform = null;
  };
};

test("a checkpoint lands as one commit on the repository's main", async () => {
  const server = await backend();
  const vault = await device(server);
  try {
    const landed = await vault.service.apply({
      base: vault.root,
      operation: "checkpoint-1",
      edits: [{ path: "notes/today.md", content: "hello" }],
    });
    assert.equal(landed.state, "landed");
    assert.equal(remoteMain(server), landed.oid);
    assert.equal(git(server.bare, "show", "main:notes/today.md").toString(), "hello");
    git(server.bare, "fsck", "--full", "--strict");
    // Writer branches stay in the object; only main reached the record.
    assert.deepEqual(
      git(server.bare, "for-each-ref", "--format=%(refname)").toString().trim().split("\n"),
      ["refs/heads/main"],
    );
  } finally {
    vault.close();
    await server.close();
  }
});

test("two writers race one main: the stale push is refused and merged again", async () => {
  const server = await backend();
  const first = await device(server);
  const second = await device(server);
  try {
    assert.equal(first.root, second.root);
    const one = await first.service.apply({
      base: first.root,
      operation: "first-device",
      edits: [{ path: "a.md", content: "from the Mac" }],
    });
    // The second device still believes main is the root; its push carries that old id.
    const two = await second.service.apply({
      base: second.root,
      operation: "second-device",
      edits: [{ path: "b.md", content: "from the phone" }],
    });
    assert.equal(two.state, "landed");
    assert.equal(remoteMain(server), two.oid);
    const parents = git(server.bare, "rev-list", "--parents", "-n", "1", "main")
      .toString()
      .trim()
      .split(" ");
    assert.ok(parents.includes(one.oid), "the merge keeps the first device's commit");
    assert.equal(git(server.bare, "show", "main:a.md").toString(), "from the Mac");
    assert.equal(git(server.bare, "show", "main:b.md").toString(), "from the phone");
    const report = server.control.pushBodies.length;
    assert.ok(report >= 3, "root, the first land, the refused land and its retry");
    git(server.bare, "fsck", "--full", "--strict");
  } finally {
    first.close();
    second.close();
    await server.close();
  }
});

test("a refusal in a wording never seen before still counts as a lost race", async () => {
  const server = await backend();
  const seen: string[] = [];
  const vault = await device(server, seen);
  try {
    // Same length as git's own "pre-receive hook declined", so the report still parses.
    refuseNextPush(server, "artifacts_unknown_reason!");
    const landed = await vault.service.apply({
      base: vault.root,
      operation: "odd-refusal",
      edits: [{ path: "note.md", content: "kept" }],
    });
    assert.equal(landed.state, "landed");
    assert.equal(git(server.bare, "show", "main:note.md").toString(), "kept");
    assert.ok(seen.includes("artifacts_unknown_reason!"), JSON.stringify(seen));
  } finally {
    vault.close();
    await server.close();
  }
});

test("a push refused every time keeps the work on its branch and never forces main", async () => {
  const server = await backend();
  const vault = await device(server);
  try {
    const before = remoteMain(server);
    const allow = refuseNextPush(server, "storage limit reached", 100);
    await assert.rejects(
      vault.service.apply({
        base: vault.root,
        operation: "always-refused",
        edits: [{ path: "note.md", content: "must survive" }],
      }),
      /Main kept advancing/,
    );
    assert.equal(remoteMain(server), before);
    allow();
    const retried = await vault.service.apply({
      base: vault.root,
      operation: "always-refused",
      edits: [{ path: "note.md", content: "must survive" }],
    });
    assert.equal(retried.state, "landed");
    assert.equal(git(server.bare, "show", "main:note.md").toString(), "must survive");
    // The retry resumed the saved writer commit rather than writing the edit again.
    assert.equal(git(server.bare, "rev-list", "--count", "main").toString().trim(), "2");
  } finally {
    vault.close();
    await server.close();
  }
});

test("a lost push reply is settled by what the repository holds", async () => {
  const server = await backend();
  const vault = await device(server);
  try {
    let lose = true;
    server.control.transform = (path, body) =>
      path.endsWith("git-receive-pack") && lose ? ((lose = false), Buffer.from("garbage")) : body;
    const landed = await vault.service.apply({
      base: vault.root,
      operation: "lost-reply",
      edits: [{ path: "note.md", content: "landed anyway" }],
    });
    assert.equal(landed.state, "landed");
    assert.equal(remoteMain(server), landed.oid);
  } finally {
    vault.close();
    await server.close();
  }
});

test("a fresh object rebuilds from the repository and reads every version", async () => {
  const server = await backend();
  const writer = await device(server);
  const v1 = await writer.service.apply({
    base: writer.root,
    operation: "v1",
    edits: [{ path: "note.md", content: "one" }],
  });
  const v2 = await writer.service.apply({
    base: v1.oid,
    operation: "v2",
    edits: [{ path: "note.md", content: "two" }],
  });
  writer.close();
  const reader = await device(server);
  try {
    assert.equal((await reader.service.read({ path: "note.md" }))?.content, "two");
    assert.equal((await reader.service.read({ path: "note.md", at: v1.oid }))?.content, "one");
    const history = await reader.drive.history({ limit: 10 });
    assert.deepEqual(
      history.slice(0, 2).map((entry) => entry.oid),
      [v2.oid, v1.oid],
    );
  } finally {
    reader.close();
    await server.close();
  }
});

test("a push that lands just before a crash finishes its receipt and quota on the next wake", async () => {
  const server = await backend();
  const data = storageFixture(),
    account = storageFixture();
  const open = (repo: VaultRepository) =>
    openVault({ ...data, accountStorage: account.storage, prefix: "vault/", repository: repo });
  try {
    const healthy = repository(server);
    const first = await open(healthy);
    let crashed = false;
    // The push reaches the repository, then the object dies before it can read anything back.
    const dying: VaultRepository = {
      ...healthy,
      async push(request) {
        await healthy.push(request);
        crashed = true;
        throw new Error("object evicted");
      },
      async refs() {
        if (crashed) throw new Error("object evicted");
        return healthy.refs();
      },
    };
    const before = await open(dying);
    await assert.rejects(
      before.service.apply({
        base: first.root,
        operation: "landed-then-crashed",
        edits: [{ path: "note.md", content: "hello" }],
      }),
    );
    assert.equal(git(server.bare, "show", "main:note.md").toString(), "hello");
    const after = await open(healthy);
    assert.equal((await after.status()).currentBytes, 5);
    const retried = await after.service.apply({
      base: first.root,
      operation: "landed-then-crashed",
      edits: [{ path: "note.md", content: "hello" }],
    });
    assert.equal(retried.state, "landed");
    assert.equal(retried.oid, remoteMain(server));
    const removed = await after.service.remove({
      base: retried.oid,
      path: "note.md",
      operation: "remove-after-crash",
    });
    assert.equal(removed.state, "landed");
    assert.equal((await after.status()).currentBytes, 0);
  } finally {
    data.close();
    account.close();
    await server.close();
  }
});

test("a fresh object books the repository's bytes and keeps its conflicts resolvable", async () => {
  const server = await backend();
  const writer = await device(server);
  const fresh = { close: () => {} };
  try {
    const one = await writer.service.apply({
      base: writer.root,
      operation: "one",
      edits: [{ path: "note.md", content: "twelve bytes" }],
    });
    const conflict = await writer.service.apply({
      base: writer.root,
      operation: "conflicting",
      edits: [{ path: "note.md", content: "other words!" }],
    });
    assert.equal(conflict.state, "conflict");
    writer.close();
    const reader = await device(server);
    fresh.close = () => reader.close();
    assert.equal((await reader.status()).currentBytes, 12);
    assert.equal(
      (await reader.service.read({ path: "note.md", at: conflict.oid }))?.content,
      "other words!",
    );
    const resolved = await reader.service.resolve({
      ref: conflict.ref,
      expected: conflict.oid,
      main: one.oid,
      edits: [{ path: "note.md", content: "both kept" }],
      operation: "resolve-on-another-device",
    });
    assert.equal(resolved.state, "landed");
    assert.equal(git(server.bare, "show", "main:note.md").toString(), "both kept");
  } finally {
    fresh.close();
    await server.close();
  }
});

test("a refused conflict-branch push retries within the land's bound", async () => {
  const server = await backend();
  const vault = await device(server);
  try {
    await vault.service.apply({
      base: vault.root,
      operation: "one",
      edits: [{ path: "note.md", content: "first" }],
    });
    refuseNextPush(server, "artifacts_unknown_reason!");
    const conflict = await vault.service.apply({
      base: vault.root,
      operation: "conflicting",
      edits: [{ path: "note.md", content: "second" }],
    });
    assert.equal(conflict.state, "conflict");
    assert.equal(
      git(server.bare, "for-each-ref", "--format=%(objectname)", "refs/heads/conflicts")
        .toString()
        .trim(),
      conflict.oid,
    );
  } finally {
    vault.close();
    await server.close();
  }
});

test("objects above SQLite's row limit are stored in parts", async () => {
  const server = await backend();
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "vault/",
      repository: repository(server),
    });
    const text = "x".repeat(3 * 1024 * 1024);
    const landed = await vault.service.apply({
      base: vault.root,
      operation: "large-note",
      edits: [{ path: "large.md", content: text }],
    });
    assert.equal(landed.state, "landed");
    const largest = [
      ...data.storage.sql.exec("SELECT MAX(length(data)) AS bytes FROM vault_git_parts"),
    ][0];
    assert.ok(Number(largest?.bytes) <= 1024 * 1024);
    assert.equal(
      Number(git(server.bare, "cat-file", "-s", "main:large.md").toString()),
      text.length,
    );
  } finally {
    data.close();
    account.close();
    await server.close();
  }
});
