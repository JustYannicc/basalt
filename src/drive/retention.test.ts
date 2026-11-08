import { test } from "node:test";
import assert from "node:assert/strict";
import { storageFixture } from "./fixture.ts";
import { openVault } from "./vault.ts";

test("retained-byte accounting survives retries and years passing without pruning canonical history", async () => {
  const data = storageFixture(),
    account = storageFixture();
  let now = 1800000000000;
  try {
    const input = { ...data, accountStorage: account.storage, prefix: "forever/", now: () => now };
    const vault = await openVault(input),
      initial = await vault.status();
    assert.ok(initial.retainedBytes > 0);
    const request = {
      base: vault.root,
      path: "note.md",
      content: "original retained version",
      mode: "create" as const,
      operation: "original",
    };
    const first = await vault.service.write(request),
      before = await vault.status();
    assert.deepEqual(await vault.service.write(request), first);
    assert.equal((await vault.status()).retainedBytes, before.retainedBytes);
    const edited = await vault.service.write({
      ...request,
      base: first.oid,
      content: "new",
      mode: "edit",
      operation: "edit",
    });
    assert.ok((await vault.status()).retainedBytes > before.retainedBytes);
    now += 2 * 365 * 86400000;
    const reopened = await openVault(input);
    assert.equal(
      (await reopened.service.read({ path: "note.md", at: first.oid }))?.content,
      request.content,
    );
    assert.equal(
      (await reopened.service.read({ path: "note.md", at: edited.oid }))?.content,
      "new",
    );
    assert.equal((await reopened.status()).reservedStorageBytes, 0);
  } finally {
    data.close();
    account.close();
  }
});

test("evicting every disposable cache preserves old versions, conflicts and owner quota", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "cache/",
      cacheBytes: 256,
    });
    const first = await vault.service.write({
      base: vault.root,
      path: "note.md",
      content: "original",
      mode: "create",
      operation: "original",
    });
    const left = await vault.service.write({
      base: first.oid,
      path: "note.md",
      content: "left",
      mode: "edit",
      operation: "left",
    });
    const right = await vault.service.write({
      base: first.oid,
      path: "note.md",
      content: "right",
      mode: "edit",
      operation: "right",
    });
    assert.equal(right.state, "conflict");
    const before = await vault.status();
    assert.ok(before.cache.bytes <= 256);
    await vault.clearCaches();
    assert.equal((await vault.status()).cache.bytes, 0);
    assert.equal((await vault.status()).currentBytes, 4);
    assert.equal((await vault.status()).retainedBytes, before.retainedBytes);
    assert.equal(
      (await vault.service.read({ path: "note.md", at: first.oid }))?.content,
      "original",
    );
    assert.equal((await vault.service.read({ path: "note.md", at: left.oid }))?.content, "left");
    assert.equal((await vault.service.read({ path: "note.md", at: right.oid }))?.content, "right");
    assert.equal((await vault.service.receipt({ operation: "right" }))?.state, "conflict");
    assert.ok((await vault.status()).cache.bytes <= 256);
  } finally {
    data.close();
    account.close();
  }
});
