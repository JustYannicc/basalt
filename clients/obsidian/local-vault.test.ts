import { test } from "node:test";
import assert from "node:assert/strict";
import { createLocalVault, recoveryFolder, type VaultPort } from "./local-vault.ts";
import { maximumFileBytes } from "./types.ts";

interface Fake {
  path: string;
  stat: { size: number };
  body: string;
}

function fakeVault(initial: Record<string, string>) {
  const files = new Map<string, Fake>(),
    folders = new Set<string>();
  const put = (path: string, body: string) =>
    files.set(path, { path, body, stat: { size: new TextEncoder().encode(body).length } });
  for (const [path, body] of Object.entries(initial)) put(path, body);
  let beforeProcess: ((file: Fake) => void) | null = null;
  const vault: VaultPort<Fake> = {
    getFiles: () => [...files.values()],
    getFileByPath: (path) => files.get(path) ?? null,
    getAbstractFileByPath: (path) => files.get(path) ?? (folders.has(path) ? { path } : null),
    read: async (file) => files.get(file.path)!.body,
    async process(file, fn) {
      beforeProcess?.(file);
      const next = fn(files.get(file.path)!.body);
      put(file.path, next);
      return next;
    },
    async create(path, data) {
      if (files.has(path)) throw new Error("File already exists.");
      put(path, data);
    },
    async createFolder(path) {
      if (folders.has(path)) throw new Error("Folder already exists.");
      folders.add(path);
    },
    async rename(file, target) {
      const current = files.get(file.path)!;
      files.delete(file.path);
      put(target, current.body);
    },
  };
  return { vault, files, folders, raceProcess: (fn: (file: Fake) => void) => (beforeProcess = fn) };
}

const now = () => new Date("2026-11-07T23:10:05Z");

test("lists attachments and excludes only recovery copies the plugin owns", async () => {
  const f = fakeVault({
    "a.md": "a",
    "img/photo.png": "bytes",
    [`${recoveryFolder}/x/old.md`]: "old",
  });
  const local = createLocalVault(f.vault, {
    recoveries: { get: () => [`${recoveryFolder}/x/old.md`], add: async () => {} },
  });
  assert.deepEqual(
    (await local.files()).map((file) => file.path),
    ["a.md", "img/photo.png"],
  );
  assert.equal(await local.read(`${recoveryFolder}/x/old.md`), null);
  assert.equal(await local.replace(`${recoveryFolder}/x/old.md`, "old", "new"), false);
});

test("a stale text replace leaves the newer local edit in place", async () => {
  const f = fakeVault({ "n.md": "base" });
  const local = createLocalVault(f.vault);
  f.raceProcess((file) => f.files.set(file.path, { ...file, body: "typed just now" }));
  assert.equal(await local.replace("n.md", "base", "cloud"), false);
  assert.equal(f.files.get("n.md")?.body, "typed just now");
});

test("a matching replace writes through Vault.process and reports the echo", async () => {
  const f = fakeVault({ "n.md": "base" }),
    writes: string[] = [];
  const local = createLocalVault(f.vault, { writing: (path) => writes.push(path) });
  assert.equal(await local.replace("n.md", "base", "cloud"), true);
  assert.equal(f.files.get("n.md")?.body, "cloud");
  assert.deepEqual(writes, ["n.md"]);
});

test("creating a note never overwrites one that appeared first", async () => {
  const f = fakeVault({ "new.md": "mine" });
  const local = createLocalVault(f.vault);
  assert.equal(await local.replace("new.md", null, "cloud"), false);
  assert.equal(f.files.get("new.md")?.body, "mine");
  assert.equal(await local.replace("deep/er/fresh.md", null, "cloud"), true);
  assert.ok(f.folders.has("deep") && f.folders.has("deep/er"));
});

test("cloud deletions move the note to a visible recovery folder instead of deleting it", async () => {
  const f = fakeVault({
    "gone.md": "keep me",
    [`${recoveryFolder}/2026-11-07T23-10-05/gone.md`]: "earlier",
  });
  const local = createLocalVault(f.vault, { now });
  assert.equal(await local.replace("gone.md", "keep me", null), true);
  assert.equal(f.files.has("gone.md"), false);
  assert.equal(f.files.get(`${recoveryFolder}/2026-11-07T23-10-05/gone (2).md`)?.body, "keep me");
  assert.equal(local.recovered().length, 1);
});

test("a deletion over a changed note does nothing", async () => {
  const f = fakeVault({ "gone.md": "edited since" });
  const local = createLocalVault(f.vault, { now });
  assert.equal(await local.replace("gone.md", "old", null), false);
  assert.equal(f.files.get("gone.md")?.body, "edited since");
  assert.equal(local.recovered().length, 0);
});

test("oversized files are never read into memory or written over", async () => {
  const f = fakeVault({ "big.md": "x" });
  f.files.get("big.md")!.stat.size = maximumFileBytes + 1;
  const local = createLocalVault(f.vault);
  assert.equal(await local.read("big.md"), null);
  assert.equal(await local.replace("big.md", null, "cloud"), false);
  assert.equal(await local.replace("big.md", "x", "cloud"), false);
  assert.equal(await local.replace("big.md", "x", null), false);
  assert.equal(f.files.get("big.md")?.body, "x");
});
