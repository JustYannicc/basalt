import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(new URL("./shell-migration-order-worker.mjs", import.meta.url));
function dependencies(mode: "deployed" | "dev") {
  const directory = mkdtempSync(join(tmpdir(), "shell-migration-order-"));
  try {
    const result = spawnSync("bun", [worker, mode], {
      env: {
        PATH: process.env.PATH,
        ALCHEMY_HOME: directory,
        ORDER_FIXTURE_DIRECTORY: directory,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a deployed shell build cannot resolve before its migration and site build", () => {
  const names = dependencies("deployed");
  assert.ok(names.includes("Migrations"), "the shell must depend on the current migration command");
  assert.ok(names.includes("Site"), "the shell must also depend on its matching site build");
});

test("local development keeps its site build without requiring a deployment migration", () => {
  assert.deepEqual(dependencies("dev"), ["Site"]);
});
