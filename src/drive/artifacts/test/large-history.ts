import { createHash } from "node:crypto";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { readEntryHeader } from "../../shared/.generated/strata/git/pack-entries.js";
import { git } from "./backend.ts";

export const sampleBytes = (version: number, file: number) =>
  createHash("shake256", { outputLength: 1024 * 1024 })
    .update(`history ${version} file ${file}`)
    .digest();

/** 48 MiB of incompressible history and an edited note which Git stores as deltas. */
export function largeHistory(root: string, bare: string) {
  const clone = join(root, "writer");
  git(root, "clone", bare, clone);
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.invalid");
  git(clone, "config", "gc.auto", "0");
  const commits: string[] = [],
    note = Array.from({ length: 6000 }, (_, i) => `Line ${i}: repeated history text`).join("\n");
  for (let version = 0; version < 8; version++) {
    for (let file = 0; file < 6; file++)
      writeFileSync(join(clone, `file-${file}.bin`), sampleBytes(version, file));
    writeFileSync(join(clone, "note.md"), `${note}\nversion ${version}\n`);
    git(clone, "add", ".");
    git(clone, "commit", "-m", `version ${version}`);
    commits.push(git(clone, "rev-parse", "HEAD").toString().trim());
  }
  git(clone, "push", "origin", "main");
  git(bare, "-c", "pack.threads=1", "gc", "--aggressive", "--prune=now");
  git(bare, "fsck", "--full", "--strict");
  const packs = join(bare, "objects", "pack"),
    packBytes = readdirSync(packs)
      .filter((name) => name.endsWith(".pack"))
      .reduce((sum, name) => sum + statSync(join(packs, name)).size, 0);
  return { commits, packBytes };
}

export function deltaKinds(pack: Uint8Array<ArrayBuffer>) {
  const kinds = new Set<string>(),
    count = new DataView(pack.buffer, pack.byteOffset, 12).getUint32(8);
  let at = 12;
  for (let index = 0; index < count; index++) {
    const header = readEntryHeader(pack, at);
    kinds.add(header.kind);
    at += header.headerLength;
    const inflated = inflateSync(pack.subarray(at), { info: true }) as unknown as {
      engine: { bytesWritten: number };
    };
    at += inflated.engine.bytesWritten;
  }
  return kinds;
}
