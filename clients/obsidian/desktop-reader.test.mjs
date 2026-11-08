import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReader } from "./plugin/desktop-reader.cjs";

test("desktop reader reads bounded ranges and rejects a file changed after its snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "basalt-obsidian-reader-"));
  try {
    const bytes = Uint8Array.from({ length: 2 * 1048576 + 19 }, (_, i) => i % 251);
    const path = join(directory, "attachment.bin");
    await writeFile(path, bytes);
    const reader = createReader(directory),
      expected = await reader.snapshot("attachment.bin");
    assert.equal(expected.bytes, bytes.length);
    assert.deepEqual(
      await reader.read("attachment.bin", expected, 1048576 - 9, 1048576),
      bytes.slice(1048576 - 9, 2 * 1048576 - 9),
    );
    await assert.rejects(reader.read("attachment.bin", expected, 0, 1048577), /range bound/);
    await writeFile(path, new Uint8Array(bytes.length + 1));
    await assert.rejects(reader.read("attachment.bin", expected, 0, 16), /changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
