import { test } from "node:test";
import assert from "node:assert/strict";
import { storageFixture } from "./fixture.ts";
import { openVault } from "./vault.ts";
import { defaultLimits } from "./quota-limits.ts";

test("a durable content quota refuses an oversized save without losing accepted history", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const input = {
      ...data,
      accountStorage: account.storage,
      prefix: "quota/",
      limits: { currentBytes: 10 },
      now: () => 1800000000000,
    };
    const vault = await openVault(input);
    const first = await vault.service.write({
      base: vault.root,
      path: "note.md",
      content: "1234567890",
      mode: "create",
      operation: "first",
    });
    await assert.rejects(
      vault.service.write({
        base: first.oid,
        path: "second.md",
        content: "x",
        mode: "create",
        operation: "second",
      }),
      /currentBytes.*10.*10/,
    );
    assert.equal((await vault.service.read({ path: "note.md" }))?.content, "1234567890");
    assert.equal(await vault.service.read({ path: "second.md" }), null);
    const restarted = await openVault(input);
    assert.equal((await restarted.status()).currentBytes, 10);
    assert.equal(
      (await restarted.service.read({ path: "note.md", at: first.oid }))?.content,
      "1234567890",
    );
  } finally {
    data.close();
    account.close();
  }
});

test("operation timestamps survive an interrupted metadata write and a full drive-index rebuild", async () => {
  const data = storageFixture(),
    account = storageFixture(),
    rebuilt = storageFixture();
  let fail = true,
    now = 1800000000000;
  const bucket = {
    ...data.bucket,
    async put(key: string, value: Parameters<typeof data.bucket.put>[1]) {
      if (fail && key.includes("/operations/")) {
        fail = false;
        throw new Error("Synthetic outage before durable metadata");
      }
      return data.bucket.put(key, value);
    },
  };
  try {
    const input = {
      storage: data.storage,
      bucket,
      accountStorage: account.storage,
      prefix: "authors/",
      now: () => now,
    };
    await assert.rejects(openVault(input), /Synthetic outage/);
    now += 60000;
    const retry = await openVault(input);
    const saved = await retry.service.write({
      base: retry.root,
      path: "note.md",
      content: "retained",
      mode: "create",
      operation: "same",
    });
    now += 60000;
    const recovered = await openVault({ ...input, storage: rebuilt.storage });
    assert.equal((await recovered.service.read({ path: "note.md" }))?.content, "retained");
    assert.equal((await recovered.service.receipt({ operation: "same" }))?.oid, saved.oid);
  } finally {
    data.close();
    account.close();
    rebuilt.close();
  }
});

test("an acknowledged R2 write with a lost reply settles its reservation from the recovered bytes", async () => {
  const data = storageFixture(),
    account = storageFixture();
  let fail = true;
  const bucket = {
    ...data.bucket,
    async put(key: string, value: Parameters<typeof data.bucket.put>[1]) {
      await data.bucket.put(key, value);
      if (fail && key.includes("/operations/")) {
        fail = false;
        throw new Error("Synthetic reply lost after R2 stored the bytes");
      }
    },
  };
  try {
    const input = {
      storage: data.storage,
      bucket,
      accountStorage: account.storage,
      prefix: "lost-reply/",
      now: () => 1800000000000,
    };
    await assert.rejects(openVault(input), /Synthetic reply lost/);
    const recovered = await openVault(input);
    const status = await recovered.status();
    assert.equal(status.reservedStorageBytes, 0);
    assert.ok(status.retainedBytes > 0);
    const again = await openVault(input);
    assert.equal((await again.status()).retainedBytes, status.retainedBytes);
  } finally {
    data.close();
    account.close();
  }
});

test("one owner shares durable quotas across vaults and monthly I/O limits retain readable files", async () => {
  const data = storageFixture(),
    other = storageFixture(),
    account = storageFixture();
  let now = 1800000000000;
  try {
    const first = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "one/",
      limits: { currentBytes: 10, classA: 40 },
      now: () => now,
    });
    const initial = await first.service.write({
      base: first.root,
      path: "kept.md",
      content: "123456",
      mode: "create",
      operation: "kept",
    });
    const second = await openVault({
      ...other,
      accountStorage: account.storage,
      prefix: "two/",
      limits: { currentBytes: 10, classA: 40 },
      now: () => now,
    });
    await assert.rejects(
      second.service.write({
        base: second.root,
        path: "too-big.md",
        content: "12345",
        mode: "create",
        operation: "too-big",
      }),
      /currentBytes.*6.*10/,
    );
    assert.equal((await second.status()).currentBytes, 6);
    let base = initial.oid,
      limited = false;
    for (let i = 0; i < 20; i++) {
      try {
        base = (
          await first.service.write({
            base,
            path: "tiny.md",
            content: "x",
            mode: i ? "edit" : "create",
            operation: `attempt-${i}`,
          })
        ).oid;
      } catch (error) {
        assert.match(String(error), /classA.*40.*resets/);
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
    assert.ok((await first.status()).classA <= 40);
    assert.equal((await first.service.read({ path: "kept.md" }))?.content, "123456");
    now = Date.UTC(2027, 2, 1);
    const resumed = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "one/",
      limits: { currentBytes: 10, classA: 40 },
      now: () => now,
    });
    const written = await resumed.service.write({
      base,
      path: "tiny.md",
      content: "y",
      mode: "edit",
      operation: "new-month",
    });
    assert.equal(written.state, "landed");
    assert.equal(
      (await resumed.service.read({ path: "kept.md", at: initial.oid }))?.content,
      "123456",
    );
  } finally {
    data.close();
    other.close();
    account.close();
  }
});

test("the default monthly R2 allowance is a guardrail a heavy Obsidian user never reaches", () => {
  assert.equal(defaultLimits.classA, 100_000);
  assert.equal(defaultLimits.classB, 1_000_000);
});
