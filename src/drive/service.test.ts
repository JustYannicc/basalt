import { test } from "node:test";
import assert from "node:assert/strict";
import { createDriveService } from "./service.ts";
import { driveFixture } from "./fixture.ts";

test("cloud tools create, list and read a note with no device connection", async () => {
  const f = await driveFixture();
  try {
    const service = createDriveService(f.drive);
    assert.deepEqual((await service.list()).entries, []);
    const input = {
      base: f.root,
      path: "notes/cloud.md",
      content: "# Cloud\n\nAvailable with every device off.\n",
      operation: "create-note",
      mode: "create" as const,
    };
    const result = await service.write(input);
    assert.equal(result.state, "landed");
    const page = await service.list({ path: "notes" });
    assert.deepEqual(
      page.entries.map((entry) => entry.name),
      ["cloud.md"],
    );
    assert.partialDeepStrictEqual(await service.read({ path: "notes/cloud.md" }), {
      content: input.content,
      at: page.at,
    });
    assert.deepEqual(await service.write(input), result);
    await assert.rejects(service.write({ ...input, content: "different" }));
    await assert.rejects(
      service.write({ ...input, base: page.at, operation: "duplicate" }),
      new RegExp("exists"),
    );
  } finally {
    f.close();
  }
});

test("cloud search continues through the whole pinned corpus while main changes", async () => {
  const f = await driveFixture();
  try {
    const service = createDriveService(f.drive);
    let base = f.root;
    for (const path of ["a.md", "folder/b.md", "folder/c.md", "z.md"]) {
      const saved = await service.write({
        base,
        path,
        content: `# ${path}\n\ncloud needle\n`,
        operation: `create-${path}`,
        mode: "create",
      });
      base = saved.oid;
    }
    const first = await service.search({ query: "needle", limit: 1, maxFiles: 2 });
    assert.equal(first.at, base);
    assert.equal(first.complete, false);
    assert.partialDeepStrictEqual(first.matches[0], { path: "a.md", line: 3 });
    await service.write({
      base,
      path: "folder/b.md",
      content: "removed from current search",
      operation: "edit-after-page",
      mode: "edit",
    });
    const matches = [...first.matches];
    let cursor = first.cursor;
    while (cursor) {
      const page = await service.search({ query: "needle", cursor, limit: 1, maxFiles: 2 });
      assert.equal(page.at, base);
      assert.ok(page.scanned <= 2);
      matches.push(...page.matches);
      cursor = page.cursor;
    }
    assert.deepEqual(
      matches.map((match) => match.path),
      ["a.md", "folder/b.md", "folder/c.md", "z.md"],
    );
    const none = await service.search({ query: "absent", maxFiles: 50 });
    assert.partialDeepStrictEqual(none, { matches: [], complete: true, cursor: null, scanned: 4 });
    for (const maxFiles of [0, 51, 1.5])
      await assert.rejects(service.search({ query: "needle", maxFiles }), new RegExp("bound"));
    await assert.rejects(
      service.search({ query: "changed", cursor: first.cursor! }),
      new RegExp("cursor"),
    );
  } finally {
    f.close();
  }
});

test("move, delete and restore create retained cloud history without overwriting a destination", async () => {
  const f = await driveFixture();
  try {
    const service = createDriveService(f.drive);
    const saved = await service.write({
      base: f.root,
      path: "old.md",
      content: "retained version\n",
      operation: "create",
      mode: "create",
    });
    const moved = await service.move({
      base: saved.oid,
      from: "old.md",
      to: "folder/new.md",
      operation: "move",
    });
    assert.equal(await service.read({ path: "old.md" }), null);
    assert.equal((await service.read({ path: "folder/new.md" }))?.content, "retained version\n");
    assert.deepEqual(
      await service.move({
        base: saved.oid,
        from: "old.md",
        to: "folder/new.md",
        operation: "move",
      }),
      moved,
    );
    await assert.rejects(
      service.move({
        base: moved.oid,
        from: "folder/new.md",
        to: "folder/new.md",
        operation: "collision",
      }),
      new RegExp("exists"),
    );
    const removed = await service.remove({
      base: moved.oid,
      path: "folder/new.md",
      operation: "delete",
    });
    assert.equal(await service.read({ path: "folder/new.md" }), null);
    const restored = await service.restore({
      base: removed.oid,
      from: saved.oid,
      path: "old.md",
      operation: "restore",
    });
    assert.equal((await service.read({ path: "old.md" }))?.content, "retained version\n");
    assert.deepEqual(
      (await service.history()).map((commit) => commit.oid),
      [restored.oid, removed.oid, moved.oid, saved.oid, f.root],
    );
    assert.equal(
      (await service.read({ path: "old.md", at: saved.oid }))?.content,
      "retained version\n",
    );
  } finally {
    f.close();
  }
});

test("note pages pin a version and keep Unicode intact within a byte bound", async () => {
  const f = await driveFixture();
  try {
    const service = createDriveService(f.drive);
    const text = "A😀é\n".repeat(200);
    const saved = await service.write({
      base: f.root,
      path: "unicode.md",
      content: text,
      operation: "unicode",
      mode: "create",
    });
    let offset: number | null = 0;
    let assembled = "";
    while (offset !== null) {
      const page = await service.read({ path: "unicode.md", at: saved.oid, offset, maxBytes: 17 });
      assert.ok(page);
      assert.ok(new TextEncoder().encode(page.content).length <= 17);
      assert.equal(page.offset, offset);
      assembled += page.content;
      assert.ok(page.next === null || page.next > offset);
      offset = page.next;
    }
    assert.equal(assembled, text);
    await assert.rejects(service.read({ path: "unicode.md", offset: 2, maxBytes: 17 }));
    await assert.rejects(service.read({ path: "unicode.md", maxBytes: 262145 }));
  } finally {
    f.close();
  }
});

test("operation status and explicit conflict resolution survive independent service instances", async () => {
  const f = await driveFixture();
  try {
    const service = createDriveService(f.drive);
    const first = await service.write({
      base: f.root,
      path: "same.md",
      content: "base\n",
      operation: "base",
      mode: "create",
    });
    const main = await service.write({
      base: first.oid,
      path: "same.md",
      content: "main\n",
      operation: "main",
      mode: "edit",
    });
    const conflict = await service.write({
      base: first.oid,
      path: "same.md",
      content: "branch\n",
      operation: "branch",
      mode: "edit",
    });
    assert.equal(conflict.state, "conflict");
    const restarted = createDriveService(f.drive);
    assert.deepEqual(await restarted.receipt({ operation: "branch" }), conflict);
    assert.equal(await restarted.receipt({ operation: "unknown" }), null);
    const input = {
      ref: conflict.ref,
      expected: conflict.oid,
      main: main.oid,
      edits: [{ path: "same.md", content: "combined\n" }],
      operation: "resolve",
    };
    const resolved = await restarted.resolve(input);
    assert.equal(resolved.state, "landed");
    assert.deepEqual(await restarted.resolve(input), resolved);
    assert.deepEqual(await restarted.receipt({ operation: "resolve" }), resolved);
    assert.equal((await service.read({ path: "same.md" }))?.content, "combined\n");
    assert.deepEqual((await service.history())[0]?.parents, [main.oid, conflict.oid]);
  } finally {
    f.close();
  }
});

test("attachment reads transfer a bounded byte range without text decoding", async () => {
  const f = await driveFixture();
  try {
    const branch = await f.drive.openWriter({
      id: "binary",
      base: f.root,
      operation: "binary-open",
    });
    const bytes = new Uint8Array([0, 255, 128, 5, 6, 7]);
    const saved = await f.drive.commit({
      ref: branch.ref,
      expected: branch.oid,
      edits: [{ path: "image.bin", content: bytes }],
      message: "Binary",
      operation: "binary-save",
    });
    await f.drive.land({ ref: branch.ref, expected: saved.oid, operation: "binary-land" });
    const service = createDriveService(f.drive);
    await assert.rejects(service.read({ path: "image.bin" }));
    const page = await service.attachment({ path: "image.bin", offset: 1, maxBytes: 3 });
    assert.ok(page);
    assert.equal(page.offset, 1);
    assert.equal(page.next, 4);
    assert.deepEqual(Buffer.from(page.contentBase64, "base64"), Buffer.from(bytes.slice(1, 4)));
  } finally {
    f.close();
  }
});
