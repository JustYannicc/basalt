import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { readEntryHeader } from "../../shared/.generated/strata/git/pack-entries.js";
import { boundedGit, git } from "./backend.ts";

// Packing, pushing and checking 48 MiB of incompressible history takes seconds on an idle core and
// several times that on a loaded runner: this bound on those git processes stops only a hung one.
export const largeGitMs = 5 * 60_000;

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
  boundedGit(largeGitMs, clone, "push", "origin", "main");
  boundedGit(largeGitMs, bare, "-c", "pack.threads=1", "gc", "--aggressive", "--prune=now");
  boundedGit(largeGitMs, bare, "fsck", "--full", "--strict");
  const packs = join(bare, "objects", "pack"),
    packBytes = readdirSync(packs)
      .filter((name) => name.endsWith(".pack"))
      .reduce((sum, name) => sum + statSync(join(packs, name)).size, 0);
  return { commits, packBytes };
}

/**
 * The large history, built once per test file while it loads, before any test's deadline runs:
 * a test copies its bare repository with `useLargeHistory` instead of building its own.
 */
export function largeHistoryOnce() {
  const root = mkdtempSync(join(tmpdir(), "large-history-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  const bare = join(root, "repo.git");
  git(root, "init", "--bare", "--initial-branch=main", bare);
  return { bare, ...largeHistory(root, bare) };
}

/** Puts the large history into a test's own bare repository, which its backend serves. */
export function useLargeHistory(history: ReturnType<typeof largeHistoryOnce>, bare: string) {
  rmSync(bare, { recursive: true, force: true });
  cpSync(history.bare, bare, { recursive: true });
  git(bare, "config", "http.receivepack", "true");
  return { commits: history.commits, packBytes: history.packBytes };
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
