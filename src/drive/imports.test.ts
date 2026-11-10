import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openVault } from "./vault.ts";
import { storageFixture } from "./fixture.ts";
import { defaultLimits } from "./quota-limits.ts";
import { decodeReceipt } from "../../clients/obsidian/remote.ts";
const note = (path: string, content: string) => ({
  path,
  kind: "note" as const,
  bytes: Buffer.byteLength(content),
  hash: createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex"),
});

test("a sealed initial import uses its own metered allowance while monthly writes remain exhausted", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({ ...data, accountStorage: account.storage, prefix: "import/" });
    account.storage.sql.exec(`UPDATE vault_io SET class_a=${defaultLimits.classA}`);
    const plan = {
      id: "first",
      page: 0,
      entries: [note("one.md", "one"), note("two.md", "two")],
      final: true,
    };
    const reservation = await vault.imports.plan(plan);
    assert.equal(reservation.state, "ready");
    assert.ok(reservation.reservedCostMicros > 0);
    assert.deepEqual(await vault.imports.plan(plan), reservation);
    const result = decodeReceipt(
      await vault.imports.run({
        id: "first",
        request: {
          operation: "drive",
          method: "apply",
          input: {
            base: vault.root,
            operation: "first-batch",
            edits: [
              { path: "one.md", content: "one" },
              { path: "two.md", content: "two" },
            ],
          },
        },
      }),
    );
    assert.equal(result.state, "landed");
    assert.equal((await vault.status()).classA, defaultLimits.classA);
    const status = await vault.imports.status("first");
    assert.ok(status);
    assert.ok(status.used.classA > 0);
    await vault.imports.finish("first");
    await assert.rejects(
      vault.service.write({
        base: result.oid,
        path: "ordinary.md",
        content: "save",
        mode: "create",
        operation: "ordinary",
      }),
      /classA/,
    );
    assert.equal((await vault.service.read({ path: "two.md" }))?.content, "two");
    await assert.rejects(vault.imports.plan({ ...plan, id: "another" }), /one initial import/);
  } finally {
    data.close();
    account.close();
  }
});

test("an import cannot spend credit on different content, an incomplete manifest or another vault", async () => {
  const data = storageFixture(),
    account = storageFixture(),
    other = storageFixture();
  try {
    const vault = await openVault({ ...data, accountStorage: account.storage, prefix: "import/" });
    await vault.imports.plan({
      id: "first",
      page: 0,
      entries: [note("one.md", "one")],
      final: false,
    });
    const request = {
      operation: "drive" as const,
      method: "apply" as const,
      input: {
        base: vault.root,
        operation: "attempt",
        edits: [{ path: "one.md", content: "changed" }],
      },
    };
    await assert.rejects(vault.imports.run({ id: "first", request }), /sealed/);
    await vault.imports.plan({ id: "first", page: 1, entries: [], final: true });
    await assert.rejects(vault.imports.run({ id: "first", request }), /manifest/);
    await assert.rejects(vault.imports.finish("first"), /unconfirmed/);
    const second = await openVault({ ...other, accountStorage: account.storage, prefix: "other/" });
    await assert.rejects(second.imports.status("first"), /not found/);
    await assert.rejects(
      vault.imports.run({
        id: "first",
        request: { operation: "drive", method: "search", input: { query: "x" } },
      }),
      /not an initial-import operation/,
    );
  } finally {
    data.close();
    account.close();
    other.close();
  }
});

test("manifest amendments and removed source records survive a lost write reply and account restart", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    let lose = false;
    const bucket = {
      ...data.bucket,
      async put(key: string, value: string | Uint8Array<ArrayBuffer>) {
        await data.bucket.put(key, value);
        if (lose && key.includes("/refs/")) {
          lose = false;
          throw new Error("Synthetic reply lost");
        }
      },
    };
    const options = {
      storage: data.storage,
      bucket,
      accountStorage: account.storage,
      prefix: "resume/",
    };
    const vault = await openVault(options);
    await vault.imports.plan({
      id: "first",
      page: 0,
      entries: [note("one.md", "old"), note("gone.md", "gone")],
      final: true,
    });
    await vault.imports.plan({
      id: "first",
      page: 1,
      entries: [note("one.md", "new")],
      removed: ["gone.md"],
      final: true,
    });
    const request = {
      operation: "drive",
      method: "apply",
      input: { base: vault.root, operation: "batch", edits: [{ path: "one.md", content: "new" }] },
    };
    account.storage.sql.exec(`UPDATE vault_io SET class_a=${defaultLimits.classA}`);
    lose = true;
    await assert.rejects(vault.imports.run({ id: "first", request }), /reply lost/);
    const restarted = await openVault(options);
    const receipt = decodeReceipt(await restarted.imports.run({ id: "first", request }));
    assert.equal(receipt.state, "landed");
    const closed = await restarted.imports.finish("first");
    assert.equal(closed.confirmed, 2);
    assert.equal(closed.omitted, 1);
    assert.equal((await restarted.status()).classA, defaultLimits.classA);
    assert.equal((await restarted.service.read({ path: "one.md" }))?.content, "new");
    assert.equal(await restarted.service.read({ path: "gone.md" }), null);
  } finally {
    data.close();
    account.close();
  }
});

test("an ordinary write queued during an import cannot borrow its allowance", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    let hold = false,
      release = () => {},
      entered = () => {};
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const bucket = {
      ...data.bucket,
      async put(key: string, value: string | Uint8Array<ArrayBuffer>) {
        if (hold) {
          hold = false;
          entered();
          await blocked;
        }
        return data.bucket.put(key, value);
      },
    };
    const vault = await openVault({
      storage: data.storage,
      bucket,
      accountStorage: account.storage,
      prefix: "queue/",
    });
    await vault.imports.plan({
      id: "first",
      page: 0,
      entries: [note("one.md", "one")],
      final: true,
    });
    account.storage.sql.exec(`UPDATE vault_io SET class_a=${defaultLimits.classA}`);
    hold = true;
    const imported = vault.imports.run({
      id: "first",
      request: {
        operation: "drive",
        method: "apply",
        input: {
          base: vault.root,
          operation: "batch",
          edits: [{ path: "one.md", content: "one" }],
        },
      },
    });
    await started;
    const ordinary = assert.rejects(
      vault.service.write({
        base: vault.root,
        path: "ordinary.md",
        content: "other",
        mode: "create",
        operation: "ordinary",
      }),
      /classA/,
    );
    release();
    assert.equal(decodeReceipt(await imported).state, "landed");
    await ordinary;
    assert.equal((await vault.status()).classA, defaultLimits.classA);
  } finally {
    data.close();
    account.close();
  }
});

test("an expired import leaves cloud reads usable and renews without resetting counted usage", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    let now = 1800000000000;
    const options = {
      ...data,
      accountStorage: account.storage,
      prefix: "expiry/",
      now: () => now,
      importPolicy: { lifetimeMs: 1000 },
    };
    const vault = await openVault(options);
    await vault.imports.plan({
      id: "first",
      page: 0,
      entries: [note("one.md", "one")],
      final: true,
    });
    const request = {
      operation: "drive",
      method: "apply",
      input: {
        base: vault.root,
        operation: "source-removed",
        edits: [{ path: "one.md", content: "one" }],
      },
    };
    await vault.imports.run({ id: "first", request });
    const before = await vault.imports.status("first");
    assert.equal(before?.omitted, 0);
    now += 1001;
    const reopened = await openVault(options);
    assert.equal((await reopened.service.read({ path: "one.md" }))?.content, "one");
    const renewed = await reopened.imports.plan({ id: "first", page: 1, entries: [], final: true });
    assert.deepEqual(renewed.used, before?.used);
    assert.ok(renewed.expiresAt > now);
    assert.equal((await reopened.imports.finish("first")).state, "complete");
  } finally {
    data.close();
    account.close();
  }
});

test("manifest admission preserves the exact exhausted account quota", async () => {
  for (const [limits, resource, used, limit] of [
    [{ files: 0 }, "files", 1, 0],
    [{ currentBytes: 2 }, "currentBytes", 3, 2],
  ] as const) {
    const data = storageFixture(),
      account = storageFixture();
    try {
      const vault = await openVault({
        ...data,
        accountStorage: account.storage,
        prefix: "quota-import/",
        limits,
      });
      await assert.rejects(
        vault.imports.plan({ id: "first", page: 0, entries: [note("one.md", "one")], final: true }),
        { resource, used, limit },
      );
    } finally {
      data.close();
      account.close();
    }
  }
});
