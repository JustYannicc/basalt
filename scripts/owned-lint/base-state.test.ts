import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { baseState } from "./base-state.ts";

const repo = mkdtempSync(join(tmpdir(), "owned-lint-base-"));
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
const write = (path: string, text: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
};
git("init", "-q");
write("scripts/owned-lint/baseline.json", '{ "basalt/no-echo-stub": { "src/old.ts": 2 } }\n');
write("src/old.ts", "export const value = 1;\nexport const other = 2;\nexport const third = 3;\n");
write("src/kept.ts", "export const kept = 1;\n");
git("add", "-A");
git("commit", "-q", "-m", "base");
const base = git("rev-parse", "HEAD");
renameSync(join(repo, "src/old.ts"), join(repo, "src/new.ts"));
write("src/added.ts", "export const added = 1;\n");
git("add", "-A");
const outside = (file: string) => file.startsWith("scripts/architecture/gen/");

test("a renamed file keeps its base path, and a file the base lacks is new and changed", () => {
  const { policy } = baseState(repo, base, outside);
  assert.deepEqual(policy.baseline, { "basalt/no-echo-stub": { "src/old.ts": 2 } });
  assert.equal(policy.basePath("src/new.ts"), "src/old.ts");
  assert.equal(policy.basePath("src/added.ts"), undefined);
  assert.equal(policy.changed("src/added.ts"), true);
  assert.equal(policy.basePath("src/kept.ts"), "src/kept.ts");
  assert.equal(policy.changed("src/kept.ts"), false);
  assert.equal(policy.lintChanged, false);
});

test("a base that is not a full commit id is refused", () => {
  assert.throws(() => baseState(repo, base.slice(0, 12), outside), /is not a commit/u);
});

test("a tracked record the base cannot read fails instead of reading as absent", () => {
  const blob = git("rev-parse", `${base}:scripts/owned-lint/baseline.json`);
  rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  assert.throws(() => baseState(repo, base, outside));
});
