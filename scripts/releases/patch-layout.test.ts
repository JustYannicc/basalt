import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { classifyRefs } from "./classify.ts";
import {
  makeReleaseRoot,
  patchFixtureContent,
  patchManifest,
  writePatchLayout,
} from "./fixtures.test-helpers.ts";
import {
  materializePatchManifest,
  parsePatchRecord,
  parseRegistrySource,
  patchRecordPath,
  serializePatchLayout,
  type RegistryFile,
} from "./patch-layout.ts";
import { readPatchManifest } from "./patches.ts";
import { sha256PatchContent } from "./patch-registry.ts";
import type { PatchRecord } from "./types.ts";

const header = JSON.stringify({ format_version: 4, repository: patchManifest.repository });
function files(): Record<string, RegistryFile> {
  return Object.fromEntries(
    [...patchManifest.patches].reverse().flatMap((patch) => [
      [patch.file, { regular: true, content: patchFixtureContent(patch.file) }],
      [patch.file.replace(/\.patch$/, ".json"), { regular: true, content: JSON.stringify(patch) }],
    ]),
  );
}

test("format 4 derives filename order and preserves deterministic record bytes and values", () => {
  const scrambled = { ...patchManifest, patches: [...patchManifest.patches].reverse() };
  const first = serializePatchLayout(scrambled);
  assert.deepEqual(first, serializePatchLayout(scrambled));
  for (const record of scrambled.patches)
    assert.equal(first.get(patchRecordPath(record.file)), `${JSON.stringify(record, null, 2)}\n`);
  assert.deepEqual(materializePatchManifest(header, files()), patchManifest);
  assert.deepEqual(
    materializePatchManifest(
      JSON.stringify(scrambled),
      Object.fromEntries(Object.entries(files()).filter(([file]) => file.endsWith(".patch"))),
    ),
    scrambled,
    "historical array order stays intact",
  );
});

test("format 4 refuses missing, orphan, mismatched, duplicate, non-regular and tampered records", () => {
  const mutations: Array<(snapshot: Record<string, RegistryFile>) => void> = [
    (snapshot) => {
      delete snapshot["0001-review.json"];
    },
    (snapshot) => {
      snapshot["orphan.json"] = snapshot["0001-review.json"]!;
    },
    (snapshot) => {
      snapshot["0001-review.json"]!.content = JSON.stringify(patchManifest.patches[1]);
    },
    (snapshot) => {
      snapshot["0001-review.json"]!.content = String(snapshot["0001-review.json"]!.content).replace(
        '"identity":',
        '"identity":"duplicate","identity":',
      );
    },
    (snapshot) => {
      snapshot["0001-review.json"]!.regular = false;
    },
    (snapshot) => {
      snapshot["0001-review.patch"]!.regular = false;
    },
    (snapshot) => {
      snapshot["0001-review.patch"]!.content = "tampered";
    },
    (snapshot) => {
      snapshot["0001-review.json"]!.content = JSON.stringify({
        ...patchManifest.patches[0],
        extra: true,
      });
    },
    (snapshot) => {
      snapshot["0004-workflow.json"]!.content = JSON.stringify({
        ...patchManifest.patches[1],
        identity: patchManifest.patches[0]!.identity,
      });
    },
    (snapshot) => {
      snapshot["0004-workflow.json"]!.content = JSON.stringify({
        ...patchManifest.patches[1],
        content_sha256: patchManifest.patches[0]!.content_sha256,
      });
    },
  ];
  for (const mutate of mutations) {
    const snapshot = files();
    mutate(snapshot);
    assert.throws(() => materializePatchManifest(header, snapshot));
  }
});

test("malformed format 4 and mixed layouts never fall back to an array", () => {
  for (const source of [
    '{"format_version":4,"format_version":3,"repository":"owner/repo","patches":[]}',
    JSON.stringify({ format_version: 4, repository: "owner/repo", patches: [] }),
    JSON.stringify({ format_version: 4, repository: "owner/repo", extra: true }),
    JSON.stringify({ format_version: 4 }),
    JSON.stringify({ format_version: 5, repository: "owner/repo" }),
  ])
    assert.throws(() => parseRegistrySource(source));
  assert.throws(() => materializePatchManifest(JSON.stringify(patchManifest), files()), /Legacy/);
});

test("filesystem loading refuses a record symlink", (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "patches/0001-review.json");
  unlinkSync(path);
  symlinkSync("0004-workflow.json", path);
  assert.throws(() => readPatchManifest(root), /regular file/);
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function commit(root: string): string {
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return git(root, "rev-parse", "HEAD");
}
function initialize(root: string): void {
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
}
function addCarry(root: string, stem: string): void {
  const file = `${stem}.patch`;
  const content = patchFixtureContent(file);
  const record: PatchRecord = {
    ...patchManifest.patches[0]!,
    file,
    identity: `executor-${stem}`,
    content_sha256: sha256PatchContent(content),
  };
  writeFileSync(join(root, "patches", file), content);
  writeFileSync(join(root, patchRecordPath(file)), `${JSON.stringify(record, null, 2)}\n`);
}

for (const retirement of [false, true]) {
  test(`ordinary Git merges an independent addition with ${retirement ? "a retirement" : "another addition"} without rewriting records`, (context) => {
    const root = makeReleaseRoot();
    context.after(() => rmSync(root, { recursive: true, force: true }));
    initialize(root);
    const base = commit(root);
    const survivor = readFileSync(join(root, "patches/0004-workflow.json"));
    git(root, "checkout", "-b", "left");
    if (retirement) git(root, "rm", "patches/0001-review.patch", "patches/0001-review.json");
    else addCarry(root, "0010-left");
    commit(root);
    git(root, "checkout", "-b", "right", base);
    addCarry(root, "0011-right");
    commit(root);
    git(root, "checkout", "main");
    git(root, "merge", "--no-edit", "left");
    git(root, "merge", "--no-edit", "right");
    assert.deepEqual(
      readPatchManifest(root).patches.map(({ file }) => file),
      retirement
        ? ["0004-workflow.patch", "0011-right.patch"]
        : ["0001-review.patch", "0004-workflow.patch", "0010-left.patch", "0011-right.patch"],
    );
    assert.deepEqual(readFileSync(join(root, "patches/0004-workflow.json")), survivor);
  });
}

test("storage-only migration keeps exact-ref classification unchanged and ignores the working tree", async (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const patch of patchManifest.patches) unlinkSync(join(root, patchRecordPath(patch.file)));
  writeFileSync(join(root, "scripts/releases/patches.json"), JSON.stringify(patchManifest));
  initialize(root);
  const base = commit(root);
  writePatchLayout(root, patchManifest);
  const head = commit(root);
  writeFileSync(join(root, "patches/0004-workflow.json"), "invalid working tree");
  const report = await classifyRefs(root, base, head);
  assert.equal(report.databaseChanged, false);
  assert.equal(report.workflowChanged, false);
  writeFileSync(join(root, "patches/0004-workflow.json"), JSON.stringify(patchManifest.patches[1]));
  unlinkSync(join(root, "patches/0001-review.json"));
  await assert.rejects(classifyRefs(root, head, commit(root)), /Missing or orphan/);
});


test("replacement provenance preserves its original digest and pin and rejects incomplete records", () => {
  const original = patchManifest.patches[0]!;
  const replacement = { ...original, rebased_from: "a".repeat(64), rebased_from_pin: "b".repeat(40) };
  const file = original.file.replace(/\.patch$/, ".json");
  assert.deepEqual(parsePatchRecord(JSON.stringify(replacement), file), replacement);
  for (const invalid of [
    { ...replacement, rebased_from: undefined },
    { ...replacement, rebased_from_pin: undefined },
    { ...replacement, rebased_from_pin: "main" },
    { ...replacement, rebased_from: original.content_sha256 },
  ]) assert.throws(() => parsePatchRecord(JSON.stringify(invalid), file));
});


test("filesystem loading verifies archived replacement bytes and identity", (context) => {
  const root = makeReleaseRoot();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const original = patchManifest.patches[0]!;
  const pin = "b".repeat(40);
  const archive = join(root, "patches/archive", pin);
  mkdirSync(archive, { recursive: true });
  const record = original.file.replace(/\.patch$/, ".json");
  const originalBytes = readFileSync(join(root, "patches", original.file));
  writeFileSync(join(archive, original.file), originalBytes);
  writeFileSync(join(archive, record), JSON.stringify(original));
  const nextBytes = Buffer.concat([originalBytes, Buffer.from("\n")]);
  writeFileSync(join(root, "patches", original.file), nextBytes);
  writeFileSync(join(root, "patches", record), JSON.stringify({
    ...original, content_sha256: sha256PatchContent(nextBytes),
    rebased_from: original.content_sha256, rebased_from_pin: pin,
  }));
  assert.equal(readPatchManifest(root).patches[0]!.rebased_from, original.content_sha256);
  writeFileSync(join(archive, original.file), "changed");
  assert.throws(() => readPatchManifest(root), /provenance mismatch/);
  writeFileSync(join(archive, original.file), originalBytes);
  writeFileSync(join(archive, record), JSON.stringify({ ...original, identity: "other-identity" }));
  assert.throws(() => readPatchManifest(root), /provenance mismatch/);
});
