import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openVault } from "./vault.ts";
import { storageFixture } from "./fixture.ts";
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const setup = () => {
  const data = storageFixture(),
    account = storageFixture();
  return {
    data,
    account,
    input: { ...data, accountStorage: account.storage, prefix: "bytes/", now: () => 1800000000000 },
    close: () => {
      data.close();
      account.close();
    },
  };
};

test("an accepted attachment charges its real bytes and preserves history across move, delete and restore", async () => {
  const fixture = setup();
  try {
    const vault = await openVault({ ...fixture.input, limits: { currentBytes: 50 } }),
      data = Uint8Array.from({ length: 40 }, (_, i) => i),
      oid = hash(data);
    const upload = await vault.attachments.begin({ operation: "upload", oid, bytes: data.length });
    await vault.attachments.put({ upload: upload.upload, part: 0, content: data });
    await vault.attachments.complete({ upload: upload.upload });
    const saved = await vault.service.attach({
      base: vault.root,
      path: "file.pdf",
      operation: "attach",
      oid,
      bytes: data.length,
    });
    assert.equal(saved.state, "landed");
    assert.equal((await vault.status()).currentBytes, 40);
    assert.equal((await vault.status()).reservedStorageBytes, 0);
    await assert.rejects(
      vault.service.write({
        base: saved.oid,
        path: "over.md",
        content: "x".repeat(11),
        mode: "create",
        operation: "over",
      }),
      /currentBytes/,
    );
    await assert.rejects(vault.service.read({ path: "file.pdf" }), /attachment/);
    const moved = await vault.service.move({
      base: saved.oid,
      from: "file.pdf",
      to: "moved.pdf",
      operation: "move",
    });
    assert.equal((await vault.status()).currentBytes, 40);
    const removed = await vault.service.remove({
      base: moved.oid,
      path: "moved.pdf",
      operation: "remove",
    });
    assert.equal((await vault.status()).currentBytes, 0);
    const restored = await vault.service.restore({
      base: removed.oid,
      from: saved.oid,
      path: "file.pdf",
      operation: "restore",
    });
    assert.equal((await vault.status()).currentBytes, 40);
    await vault.clearCaches();
    const reopened = await openVault(fixture.input);
    assert.equal(
      (await reopened.service.attachment({ path: "file.pdf", at: restored.oid }))?.contentBase64,
      Buffer.from(data).toString("base64"),
    );
    assert.equal(
      (await reopened.service.attachment({ path: "file.pdf", at: saved.oid }))?.bytes,
      40,
    );
    const search = await reopened.service.search({ query: "git-lfs", maxFiles: 20 });
    assert.deepEqual(search.matches, []);
    assert.deepEqual(search.skippedBinary, ["file.pdf"]);
  } finally {
    fixture.close();
  }
});
test("whole-upload reservations prevent competing partial uploads from filling each other's completion space", async () => {
  const fixture = setup();
  try {
    const vault = await openVault({ ...fixture.input, limits: { retainedBytes: 80000 } }),
      baseline = (await vault.status()).retainedBytes,
      data = new Uint8Array(50000).fill(7),
      oid = hash(data);
    const upload = await vault.attachments.begin({ operation: "first", oid, bytes: data.length });
    const reserved = await vault.status();
    assert.ok(reserved.reservedStorageBytes >= data.length);
    await assert.rejects(
      vault.attachments.begin({
        operation: "second",
        oid: hash(new Uint8Array(50000).fill(8)),
        bytes: 50000,
      }),
      /retainedBytes/,
    );
    await vault.attachments.put({ upload: upload.upload, part: 0, content: data });
    await vault.attachments.cancel({ upload: upload.upload });
    const after = await vault.status();
    assert.equal(after.reservedStorageBytes, 0);
    assert.ok(after.retainedBytes < baseline + 4096);
    const next = await vault.attachments.begin({ operation: "third", oid, bytes: data.length });
    assert.equal(next.state, "uploading");
  } finally {
    fixture.close();
  }
});
test("unknown attachment writes retain their reservation and invalid pointers never become main", async () => {
  const fixture = setup();
  let lose = true;
  try {
    const bucket = {
      ...fixture.data.bucket,
      async put(key: string, value: Parameters<typeof fixture.data.bucket.put>[1]) {
        await fixture.data.bucket.put(key, value);
        if (lose && key.includes("/parts/")) {
          lose = false;
          throw new Error("Lost R2 reply");
        }
      },
    };
    const input = { ...fixture.input, bucket },
      vault = await openVault(input),
      data = new Uint8Array(40000).fill(3),
      oid = hash(data),
      upload = await vault.attachments.begin({ operation: "lost", oid, bytes: data.length });
    await assert.rejects(
      vault.attachments.put({ upload: upload.upload, part: 0, content: data }),
      /Lost R2 reply/,
    );
    assert.ok((await vault.status()).reservedStorageBytes >= data.length);
    const fresh = await openVault(input);
    await fresh.attachments.put({ upload: upload.upload, part: 0, content: data });
    await fresh.attachments.complete({ upload: upload.upload });
    assert.equal((await fresh.status()).reservedStorageBytes, 0);
    await assert.rejects(
      fresh.service.attach({
        base: fresh.root,
        path: "fake.pdf",
        operation: "fake",
        oid: "a".repeat(64),
        bytes: 1,
      }),
      /missing/,
    );
    assert.equal(await fresh.service.attachment({ path: "fake.pdf" }), null);
  } finally {
    fixture.close();
  }
});
