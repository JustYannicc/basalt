import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runSyncCommand } from "./upstream-sync.ts";
import { compareSyncInventories } from "./upstream-sync/compare.ts";
import {
  addition,
  change,
  commit,
  syncFixture,
  write,
} from "./upstream-sync/fixtures.test-helpers.ts";
import { git } from "./upstream-sync/git.ts";
import { strictReplay } from "./upstream-sync/replay.ts";
import { loadSyncSnapshot, sha256 } from "./upstream-sync/snapshot.ts";

test("inventory reads exact commit bytes and orders equal numeric prefixes by whole filename", (context) => {
  const fixture = syncFixture(context, {
    "0001-z-last.patch": addition("last.ts", "last"),
    "0001-a-first.patch": change("entry.txt", "base", "first"),
  });
  const first = loadSyncSnapshot(fixture.root, fixture.candidate);
  write(fixture.root, "patches/0001-a-first.patch", "uncommitted corruption");
  const second = loadSyncSnapshot(fixture.root, "HEAD");
  assert.deepEqual(second.inventory, first.inventory);
  assert.deepEqual(
    first.inventory.carries.map((carry) => carry.file),
    ["0001-a-first.patch", "0001-z-last.patch"],
  );
  assert.deepEqual(first.inventory.carries[0]!.targets, ["entry.txt"]);
  assert.equal(first.inventory.carries[0]!.content_sha256, sha256(first.patches[0]!.content));
});

test("inventory refuses committed patch digest drift before it can become replay evidence", (context) => {
  const fixture = syncFixture(context, {
    "0001-first.patch": change("entry.txt", "base", "first"),
  });
  write(fixture.root, "patches/0001-first.patch", change("entry.txt", "base", "tampered"));
  const candidate = commit(fixture.root);
  assert.throws(() => loadSyncSnapshot(fixture.root, candidate), /digest does not match/);
});

test("strict replay retains the first failure, leaves its suffix unattempted and preserves the input checkout", (context) => {
  const fixture = syncFixture(context, {
    "0001-first.patch": change("entry.txt", "base", "first"),
    "0002-conflict.patch": change("entry.txt", "unrelated", "wrong"),
    "0003-independent.patch": addition("later.ts", "would apply"),
  });
  write(fixture.objects, "entry.txt", "owner edits must survive\n");
  write(fixture.objects, "sentinel.txt", "untracked owner state\n");
  const prior = git(fixture.objects, ["status", "--porcelain"]);
  const snapshot = loadSyncSnapshot(fixture.root, fixture.candidate);
  const output = join(fixture.directory, "failed-proof");
  const result = strictReplay(snapshot, {
    objects: fixture.objects,
    target: fixture.target,
    output,
  });
  assert.equal(result.passed, false);
  assert.equal(result.failure?.carry, "0002-conflict.patch");
  assert.equal(result.failure?.phase, "check");
  assert.equal(result.applied, 1);
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.unattempted, ["0003-independent.patch"]);
  assert.equal(result.finalTree, null);
  assert.equal(result.contracts, null);
  assert.equal(existsSync(join(output, "effective.patch")), false);
  assert.match(readFileSync(join(output, "0002-conflict.patch.log"), "utf8"), /patch failed/);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "result.json"), "utf8")), result);
  assert.equal(
    readdirSync(output).some((path) => path.startsWith(".source-")),
    false,
  );
  assert.equal(git(fixture.objects, ["status", "--porcelain"]), prior);
  assert.equal(git(fixture.objects, ["rev-parse", "HEAD"]).trim(), fixture.target);
  assert.equal(
    readFileSync(join(fixture.objects, "entry.txt"), "utf8"),
    "owner edits must survive\n",
  );
  const retained = readFileSync(join(output, "result.json"));
  assert.throws(
    () => strictReplay(snapshot, { objects: fixture.objects, target: fixture.target, output }),
    /EEXIST/,
  );
  assert.deepEqual(readFileSync(join(output, "result.json")), retained);
});

test("complete replay uses production addition cleanup and hashes all final source including ignored carries", (context) => {
  const fixture = syncFixture(context, {
    "0001-create.patch": change("entry.txt", "base", "first") + addition("replacement.ts", "first"),
    "0002-replace.patch": addition("replacement.ts", "replacement"),
    "0003-generated.patch": addition("generated.txt", "carried ignored file"),
  });
  const snapshot = loadSyncSnapshot(fixture.root, fixture.candidate);
  const output = join(fixture.directory, "complete-proof");
  const result = strictReplay(snapshot, {
    objects: fixture.objects,
    target: fixture.target,
    output,
  });
  assert.equal(result.passed, true);
  assert.equal(result.applied, 3);
  assert.deepEqual(result.unattempted, []);
  assert.equal(result.failure, null);
  assert.match(readFileSync(join(output, "effective.patch"), "utf8"), /\+replacement/);
  assert.match(readFileSync(join(output, "effective.patch"), "utf8"), /\+carried ignored file/);
  write(fixture.objects, "entry.txt", "first\n");
  write(fixture.objects, "replacement.ts", "replacement\n");
  write(fixture.objects, "generated.txt", "carried ignored file\n");
  git(fixture.objects, ["add", "--all", "--force"]);
  assert.equal(result.finalTree, git(fixture.objects, ["write-tree"]).trim());
  assert.equal(
    readdirSync(output).some((path) => path.startsWith(".source-")),
    false,
  );
  assert.deepEqual(JSON.parse(readFileSync(join(output, "cleanup.json"), "utf8")), {
    sourceRemoved: true,
  });
});

test("missing target objects retain a tool failure and never masquerade as a carry conflict", (context) => {
  const fixture = syncFixture(context, {
    "0001-first.patch": change("entry.txt", "base", "first"),
  });
  const snapshot = loadSyncSnapshot(fixture.root, fixture.candidate);
  const result = strictReplay(snapshot, {
    objects: fixture.objects,
    target: "1".repeat(40),
    output: join(fixture.directory, "missing-target"),
  });
  assert.equal(result.passed, false);
  assert.equal(result.failure?.phase, "resolve-target");
  assert.equal(result.failure?.carry, null);
  assert.equal(result.applied, 0);
  assert.deepEqual(result.unattempted, ["0001-first.patch"]);
});

test("inventory comparison isolates metadata and pin changes without invalidating unchanged inputs", (context) => {
  const fixture = syncFixture(context, {
    "0001-first.patch": change("entry.txt", "base", "first"),
    "0002-tail.patch": addition("tail.ts", "tail"),
  });
  const before = loadSyncSnapshot(fixture.root, fixture.candidate).inventory;
  write(fixture.root, "tooling.ts", "only tool code changed\n");
  const same = loadSyncSnapshot(fixture.root, commit(fixture.root)).inventory;
  assert.equal(same.inputSha256, before.inputSha256);
  const reused = compareSyncInventories(before, same);
  assert.equal(reused.reusablePrefix, 2);
  assert.equal(reused.firstInvalidatedCarry, null);
  assert.deepEqual(reused.changed, []);
  assert.deepEqual(
    reused.repositoryChanges.map((entry) => entry.file),
    ["tooling.ts"],
  );
  const path = "patches/0002-tail.json";
  const record = JSON.parse(readFileSync(join(fixture.root, path), "utf8"));
  write(fixture.root, path, JSON.stringify({ ...record, database_sensitive: true }));
  const after = loadSyncSnapshot(fixture.root, commit(fixture.root)).inventory;
  const changed = compareSyncInventories(before, after);
  assert.equal(changed.reusablePrefix, 1);
  assert.equal(changed.firstInvalidatedCarry, "0002-tail.patch");
  assert.deepEqual(changed.unchanged, [before.carries[0]!.identity]);
  assert.ok(
    changed.changed[0]!.changes.some(
      (entry) =>
        entry.property === "database_sensitive" && entry.before === false && entry.after === true,
    ),
  );
  write(
    fixture.root,
    "upstream.json",
    JSON.stringify({ ...before.upstream, commit: "2".repeat(40) }),
  );
  const repinned = compareSyncInventories(
    after,
    loadSyncSnapshot(fixture.root, commit(fixture.root)).inventory,
  );
  assert.equal(repinned.upstreamChanged, true);
  assert.equal(repinned.reusablePrefix, 0);
});

test("command line retains immutable inventories and rejects unknown or duplicate options", (context) => {
  const fixture = syncFixture(context, {
    "0001-first.patch": change("entry.txt", "base", "first"),
  });
  const output = join(fixture.directory, "inventory-proof");
  const args = ["inventory", "--ref", fixture.candidate, "--output", output];
  const result = runSyncCommand(args, fixture.root);
  assert.equal(result.exitCode, 0);
  assert.equal(
    JSON.parse(readFileSync(join(output, "inventory.json"), "utf8")).basalt.commit,
    fixture.candidate,
  );
  assert.throws(() => runSyncCommand(args, fixture.root), /EEXIST/);
  assert.throws(() => runSyncCommand([...args, "--force", "true"], fixture.root), /Usage/);
  assert.throws(() => runSyncCommand([...args, "--ref", "HEAD"], fixture.root), /Usage/);
  assert.throws(
    () =>
      strictReplay(loadSyncSnapshot(fixture.root, fixture.candidate), {
        objects: fixture.objects,
        target: fixture.target,
        output: join(fixture.objects, "proof"),
      }),
    /separate from the input/,
  );
});
