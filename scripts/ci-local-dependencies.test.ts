import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = (name: string) => join(root, "scripts/ci", name);
const executable = (path: string, body: string) =>
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });

test("the complete local gate must enter heavy-slot before any preparation or checks", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-fast-slot-"));
  try {
    const receipt = join(directory, "receipt");
    executable(
      join(directory, "heavy-slot"),
      'printf "%s\\n" "$HEAVY_SLOTS" "$@" > "$SLOT_RECEIPT"\nexit 23',
    );
    const result = spawnSync(process.execPath, [script("fast-local.ts"), "--base", "origin/main"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: directory,
        HEAVY_SLOT_ACTIVE: "",
        HEAVY_SLOTS: "",
        SLOT_RECEIPT: receipt,
      },
    });
    assert.equal(result.status, 23, result.stderr);
    const [slots, node, entrypoint, ...args] = readFileSync(receipt, "utf8").trimEnd().split("\n");
    assert.equal(slots, "6");
    assert.equal(node, process.execPath);
    assert.equal(entrypoint, script("fast-local.ts"));
    assert.deepEqual(args, ["--base", "origin/main"]);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing slot wrapper fails before running the complete gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-fast-no-slot-"));
  try {
    const result = spawnSync(process.execPath, [script("fast-local.ts")], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory, HEAVY_SLOT_ACTIVE: "" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires heavy-slot on PATH/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow lint refuses to pass when ShellCheck is unavailable", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-no-shellcheck-"));
  try {
    const receipt = join(directory, "actionlint-ran");
    executable(join(directory, "actionlint"), 'printf ran > "$ACTIONLINT_RECEIPT"\nexit 0');
    const result = spawnSync(process.execPath, [script("check-workflows.ts")], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory, ACTIONLINT_RECEIPT: receipt },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ShellCheck is required/);
    assert.equal(existsSync(receipt), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("workflow lint enables ShellCheck explicitly and preserves actionlint's failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-shellcheck-"));
  try {
    const receipt = join(directory, "actionlint-args");
    executable(join(directory, "shellcheck"), 'echo "ShellCheck version: 0.11.0"');
    executable(
      join(directory, "actionlint"),
      'if [ "$1" = -version ]; then echo 1.7.12; exit 0; fi\nprintf "%s\\n" "$@" > "$ACTIONLINT_RECEIPT"\nexit 29',
    );
    const result = spawnSync(process.execPath, [script("check-workflows.ts")], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory, ACTIONLINT_RECEIPT: receipt },
    });
    assert.equal(result.status, 29, result.stderr);
    assert.equal(readFileSync(receipt, "utf8"), "-shellcheck\nshellcheck\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
