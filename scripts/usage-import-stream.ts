import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { maximumImportBytes } from "../src/pool/model-history/import.ts";
import { historyBatchSize } from "../src/pool/model-history/store.ts";

/** Streaming, byte-bounded lines. A malicious unterminated line cannot fill memory. */
export async function* metadataLines(path: string): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const raw of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let start = 0;
    for (let end = 0; end < chunk.length; end++) {
      if (chunk[end] !== 10) continue;
      const piece = chunk.subarray(start, end);
      if (pending.length + piece.length > maximumImportBytes)
        throw new Error("Metadata line exceeds page limit");
      const line = Buffer.concat([pending, piece]);
      pending = Buffer.alloc(0);
      start = end + 1;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(line).replace(/\r$/, "");
      if (text.trim()) yield text;
    }
    const rest = chunk.subarray(start);
    if (pending.length + rest.length > maximumImportBytes)
      throw new Error("Metadata line exceeds page limit");
    pending = Buffer.concat([pending, rest]);
  }
  if (pending.length) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(pending).replace(/\r$/, "");
    if (text.trim()) yield text;
  }
}

/** The same file always has the same page boundaries, independent of stream chunking. */
export async function* metadataPages(path: string): AsyncGenerator<string> {
  let lines: string[] = [],
    bytes = 0;
  for await (const line of metadataLines(path)) {
    const size = Buffer.byteLength(line);
    if (
      lines.length &&
      (lines.length === historyBatchSize || bytes + 1 + size > maximumImportBytes)
    ) {
      yield lines.join("\n");
      lines = [];
      bytes = 0;
    }
    bytes += size + (lines.length ? 1 : 0);
    lines.push(line);
  }
  if (lines.length) yield lines.join("\n");
}

export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Export directories keep their page boundaries without concatenating a second full copy. */
export async function metadataInput(path: string) {
  const directory = (await stat(path)).isDirectory();
  const files = directory
    ? (await readdir(path))
        .filter((name) => /^\d{6}\.jsonl$/.test(name))
        .sort()
        .map((name) => join(path, name))
    : [path];
  if (!files.length) throw new Error("No metadata pages");
  const digest = async () => {
    const hash = createHash("sha256");
    if (directory) hash.update(await fileDigest(join(path, "pages.jsonl")));
    for (let index = 0; index < files.length; index++) {
      if (directory && files[index] !== join(path, `${String(index).padStart(6, "0")}.jsonl`))
        throw new Error("Noncontiguous metadata pages");
      hash.update(JSON.stringify([index, await fileDigest(files[index]!)]));
    }
    return hash.digest("hex");
  };
  async function* pages() {
    for (const file of files) yield* metadataPages(file);
  }
  return { digest, pages };
}
