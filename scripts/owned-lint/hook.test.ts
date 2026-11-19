import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { editedFiles, otherCheckout, runStep, verdict } from "./hook.ts";

const repository = "/work/basalt";

test("a Claude Code edit names its file", () => {
  assert.deepEqual(
    editedFiles(
      {
        cwd: repository,
        tool_name: "Edit",
        tool_input: { file_path: `${repository}/src/pool/a.ts` },
      },
      repository,
    ),
    ["src/pool/a.ts"],
  );
});

test("a Codex patch names every file it adds, updates or moves to, relative to its cwd", () => {
  const command = [
    "*** Begin Patch",
    "*** Add File: ../scripts/new.ts",
    "+export const a = 1;",
    "*** Update File: pool/old.ts",
    "*** Move to: pool/renamed.ts",
    "@@",
    "*** Delete File: pool/gone.ts",
    "*** Update File: ../docs/notes.md",
    "*** End Patch",
  ].join("\n");
  assert.deepEqual(
    editedFiles(
      { cwd: `${repository}/src`, tool_name: "apply_patch", tool_input: { command } },
      repository,
    ),
    ["scripts/new.ts", "src/pool/old.ts", "src/pool/renamed.ts"],
  );
});

test("files outside the repository and files the fast lane does not lint are left alone", () => {
  for (const file_path of ["/elsewhere/a.ts", `${repository}/README.md`, ""])
    assert.deepEqual(
      editedFiles({ cwd: repository, tool_name: "Write", tool_input: { file_path } }, repository),
      [],
    );
});

test("a payload whose fields are not text names no file instead of throwing", () => {
  for (const payload of [
    { tool_name: "apply_patch", tool_input: { command: ["*** Add File: src/a.ts"] } },
    { tool_name: "Edit", tool_input: { file_path: 7 } },
    { cwd: 1, tool_name: "Edit" },
  ])
    assert.deepEqual(editedFiles(payload, repository), [], JSON.stringify(payload));
});

const node = (code: string) => ({
  label: "tool",
  command: process.execPath,
  args: ["-e", code],
  cwd: process.cwd(),
});

test("a step that exits non-zero is a finding, with its output", () => {
  const outcome = runStep(
    node("console.error('src/a.ts:1 bad'); process.exit(1)"),
    Date.now() + 30_000,
  );
  assert.deepEqual(outcome, { failure: "tool:\nsrc/a.ts:1 bad" });
  assert.deepEqual(runStep(node("process.exit(0)"), Date.now() + 30_000), {});
});

test("a step that cannot start or runs out of time is the hook's failure, not the edit's", () => {
  const missing = runStep({ ...node(""), command: "/missing/oxfmt" }, Date.now() + 30_000);
  assert.match(missing.crash ?? "", /^tool could not run \(spawnSync \/missing\/oxfmt ENOENT\)/u);
  const hung = runStep(node("setInterval(() => {}, 1_000)"), Date.now() + 200);
  assert.match(hung.crash ?? "", /^tool could not run \(/u);
  assert.equal(hung.failure, undefined);
});

test("findings block the agent; a step that could not run only reports", () => {
  assert.equal(verdict([{}, {}]).exit, 0);
  const crashed = verdict([{ crash: "oxfmt could not run (x)" }]);
  assert.equal(crashed.exit, 1);
  assert.match(crashed.message, /did not finish:\noxfmt could not run \(x\)/u);
  const failed = verdict([
    { failure: "owned lint:\nsrc/a.ts" },
    { crash: "oxfmt could not run (x)" },
  ]);
  assert.equal(failed.exit, 2);
  assert.match(
    failed.message,
    /^The fast lane would fail on this edit\.[\s\S]*owned lint:\nsrc\/a\.ts\n\noxfmt could not run/u,
  );
});

const scratch = mkdtempSync(join(tmpdir(), "owned-lint-hook-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("an edit in another checkout of this repository is left to that checkout's hook", () => {
  const other = join(scratch, "worktree");
  mkdirSync(join(other, "scripts/owned-lint"), { recursive: true });
  execFileSync("git", ["init", "-q", other]);
  writeFileSync(join(other, "scripts/owned-lint/hook.ts"), "");
  writeFileSync(join(other, "scripts/a.ts"), "");
  assert.equal(otherCheckout([join(other, "scripts/a.ts")]), realpathSync(other));
  assert.equal(otherCheckout([join(other, "scripts/a.ts")], other), undefined);
  assert.equal(otherCheckout([join(scratch, "gone.ts")]), undefined);
});
