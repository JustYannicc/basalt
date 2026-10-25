import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("production entrypoint refuses developer-machine deployment before reading credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/deploy.ts"], {
    env: { PATH: process.env.PATH, GITHUB_ACTIONS: "false" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production deployment runs only in GitHub Actions/);
  assert.doesNotMatch(result.stderr, /Missing GitHub Actions secret/);
  assert.equal(result.stdout, "");
});

test("production entrypoint runs Alchemy with every argument instead of a bare `bun exec alchemy`", () => {
  const source = readFileSync("scripts/deploy.ts", "utf8");
  assert.doesNotMatch(source, /"bun",\s*\[\s*"exec"/);
  assert.equal(source.match(/\["run",\s*"alchemy",\s*"deploy"|"run",\s*\n\s*"alchemy",\s*\n\s*"deploy"/g)?.length, 2);
});
