import assert from "node:assert/strict";
import { test } from "node:test";
import { editedFiles } from "./hook.ts";

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
