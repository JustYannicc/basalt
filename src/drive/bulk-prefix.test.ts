import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { storageFixture } from "./fixture.ts";
import { openVault } from "./vault.ts";
import type { AttachmentBucket } from "./shared/index.ts";

test("vault recovery, attachment reads and cancellation cannot see bulk import keys", async () => {
  const data = storageFixture();
  const account = storageFixture();
  const prefix = "vault-fixture/";
  const importKey = `usage-import-v1/${"a".repeat(64)}/0.ndjson`;
  await data.bucket.put(importKey, "retained import metadata");
  const operations: { operation: string; key: string }[] = [];
  const scoped = (operation: string, key: string) => {
    assert.ok(key.startsWith(prefix), `${operation} escaped the vault prefix: ${key}`);
    operations.push({ operation, key });
  };
  const bucket: AttachmentBucket = {
    put(key, value) {
      scoped("put", key);
      return data.bucket.put(key, value);
    },
    get(key, options) {
      scoped("get", key);
      return data.bucket.get(key, options);
    },
    list(options) {
      scoped("list", options.prefix);
      return data.bucket.list(options);
    },
    delete(key) {
      scoped("delete", key);
      return data.bucket.delete(key);
    },
  };
  const input = { storage: data.storage, accountStorage: account.storage, bucket, prefix };
  try {
    const vault = await openVault(input);
    const content = new TextEncoder().encode("vault bytes");
    const oid = createHash("sha256").update(content).digest("hex");
    const upload = await vault.attachments.begin({
      operation: "accepted",
      oid,
      bytes: content.length,
    });
    await vault.attachments.put({ upload: upload.upload, part: 0, content });
    await vault.attachments.complete({ upload: upload.upload });
    assert.deepEqual((await vault.attachments.read({ oid })).content, content);
    const partial = await vault.attachments.begin({
      operation: "cancelled",
      oid: "b".repeat(64),
      bytes: 1,
    });
    await vault.attachments.put({ upload: partial.upload, part: 0, content: new Uint8Array([1]) });
    await vault.attachments.cancel({ upload: partial.upload });
    await vault.clearCaches();
    const reopened = await openVault(input);
    assert.deepEqual((await reopened.attachments.read({ oid })).content, content);
    assert.ok(operations.some(({ operation }) => operation === "list"));
    assert.ok(operations.some(({ operation }) => operation === "delete"));
    assert.equal(
      new TextDecoder().decode(await (await data.bucket.get(importKey))!.arrayBuffer()),
      "retained import metadata",
    );
  } finally {
    account.close();
    data.close();
  }
});
