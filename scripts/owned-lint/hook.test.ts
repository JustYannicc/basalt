import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { editedFiles, otherCheckouts, runStep, verdict } from "./hook.ts";

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
// Another checkout whose hook echoes the payload it was handed and exits 2.
const other = join(scratch, "worktree");
mkdirSync(join(other, "scripts/owned-lint"), { recursive: true });
execFileSync("git", ["init", "-q", other]);
writeFileSync(
  join(other, "scripts/owned-lint/hook.ts"),
  'process.stderr.write("other hook: " + require("node:fs").readFileSync(0, "utf8")); process.exit(2);\n',
);
writeFileSync(join(other, "scripts/a.ts"), "");
const hook = fileURLToPath(new URL("./hook.ts", import.meta.url));
const runHook = (payload: Parameters<typeof editedFiles>[0], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

test("each other checkout an edit reaches is found once", () => {
  const edited = join(other, "scripts/a.ts");
  assert.deepEqual(otherCheckouts([edited, edited, join(scratch, "gone.ts")]), [
    realpathSync(other),
  ]);
  assert.deepEqual(otherCheckouts([edited], other), []);
});

test("an edit in another checkout gets that checkout's verdict, and is never handed back", () => {
  const payload = { cwd: other, tool_name: "Write", tool_input: { file_path: "scripts/a.ts" } };
  const handed = runHook(payload);
  assert.equal(handed.status, 2);
  assert.match(handed.stderr, /^other hook: \{"cwd":/u);
  const received = runHook(payload, { OWNED_LINT_HOOK_HANDED_OFF: "1" });
  assert.equal(received.status, 0);
  assert.equal(received.stderr, "");
});

test("an apply_patch payload the hook cannot read is reported without blocking the edit", () => {
  const result = runHook({ cwd: scratch, tool_name: "apply_patch", tool_input: { command: "x" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no file headers in this apply_patch payload/u);
});

test("indented patch headers and a symbolic link to the checkout name the same files", () => {
  const command = "*** Begin Patch\n  *** Update File: scripts/a.ts\n*** End Patch";
  const link = join(scratch, "link");
  symlinkSync(other, link);
  assert.deepEqual(
    editedFiles(
      { cwd: link, tool_name: "apply_patch", tool_input: { command } },
      realpathSync(other),
    ),
    ["scripts/a.ts"],
  );
});
