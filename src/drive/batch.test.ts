import { test } from "node:test";
import assert from "node:assert/strict";
import { storageFixture } from "./fixture.ts";
import { openVault } from "./vault.ts";

test("an import batch lands atomically and a quota refusal preserves its preceding revision", async () => {
  const data = storageFixture(),
    account = storageFixture();
  try {
    const vault = await openVault({
      ...data,
      accountStorage: account.storage,
      prefix: "batch/",
      limits: { currentBytes: 12 },
    });
    const first = await vault.service.apply({
      base: vault.root,
      operation: "first",
      edits: [
        { path: "a/one.md", content: "first" },
        { path: "b/two.md", content: "second" },
      ],
    });
    assert.equal(first.state, "landed");
    assert.equal((await vault.status()).currentBytes, 11);
    assert.equal((await vault.service.read({ path: "a/one.md", at: first.oid }))?.content, "first");
    await assert.rejects(
      vault.service.apply({
        base: first.oid,
        operation: "too-large",
        edits: [
          { path: "a/one.md", content: "changed" },
          { path: "c/three.md", content: "new" },
        ],
      }),
      /currentBytes.*11.*12/,
    );
    assert.equal((await vault.service.read({ path: "a/one.md" }))?.content, "first");
    assert.equal(await vault.service.read({ path: "c/three.md" }), null);
    const retry = await vault.service.apply({
      base: vault.root,
      operation: "first",
      edits: [
        { path: "a/one.md", content: "first" },
        { path: "b/two.md", content: "second" },
      ],
    });
    assert.deepEqual(retry, first);
  } finally {
    data.close();
    account.close();
  }
});
