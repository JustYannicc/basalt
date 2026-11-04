import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { metadataLines, metadataPages, metadataInput, fileDigest } from "./usage-import-stream.ts";
import { maximumImportBytes } from "../src/pool/model-history/import.ts";
test("streaming preserves UTF-8 and deterministic pages across chunk boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basalt-import-stream-"));
  try {
    const file = join(dir, "rows.jsonl");
    const rows = Array.from({ length: 401 }, (_, n) =>
      JSON.stringify({ n, label: "é".repeat(400) }),
    );
    await writeFile(file, rows.join("\r\n"));
    const pages = [];
    for await (const page of metadataPages(file)) pages.push(page);
    assert.deepEqual(
      pages.map((page) => page.split("\n").length),
      [200, 200, 1],
    );
    assert.deepEqual(
      pages.flatMap((page) => page.split("\n")),
      rows,
    );
    assert.match(await fileDigest(file), /^[a-f0-9]{64}$/);
    await writeFile(file, "x".repeat(maximumImportBytes + 1));
    await assert.rejects(async () => {
      for await (const _ of metadataLines(file)) {
      }
    });
    await writeFile(file, Buffer.from([0xc3, 0x28, 10]));
    await assert.rejects(async () => {
      for await (const _ of metadataLines(file)) {
      }
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("export directories stream without a concatenated copy and bind page bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basalt-import-directory-"));
  try {
    await writeFile(join(dir, "pages.jsonl"), "receipt\n");
    await writeFile(join(dir, "000000.jsonl"), '{"n":1}\n');
    await writeFile(join(dir, "000001.jsonl"), '{"n":2}\n');
    const input = await metadataInput(dir),
      before = await input.digest();
    const pages = [];
    for await (const page of input.pages()) pages.push(page);
    assert.deepEqual(pages, ['{"n":1}', '{"n":2}']);
    await writeFile(join(dir, "000001.jsonl"), '{"n":3}\n');
    assert.notEqual(await input.digest(), before);
    const gap = join(dir, "gap");
    await mkdir(gap);
    await writeFile(join(gap, "pages.jsonl"), "receipt\n");
    await writeFile(join(gap, "000001.jsonl"), "{}\n");
    await assert.rejects((await metadataInput(gap)).digest());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
