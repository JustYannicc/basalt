import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { shipAlone } from "./ship-alone.ts";

const root = new URL("../..", import.meta.url).pathname;
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 }).trim();
const present = (sha: string) =>
  spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root }).status === 0;
const needsHistory = {
  skip: ["dae3b3278", "42c7cfe5b"].every(present) ? false : "needs the full repository history",
};
// Files a merge into main brought in, compared with main before it.
const merged = (sha: string) =>
  git(["diff", "--name-only", "--no-renames", `${sha}^1`, sha])
    .split("\n")
    .filter(Boolean);

test(
  "refuses the 16 Nov batch that replaced the release path alongside pool features",
  needsHistory,
  () => {
    const result = shipAlone(merged("dae3b3278"));
    assert.equal(result.pass, false);
    assert.equal(result.releasePath.length, 127);
    assert.ok(result.other.some((file) => file.startsWith("src/pool/")));
  },
);

test(
  "passes a release fix that touches only the release path, its carries model and docs",
  needsHistory,
  () => {
    // 42c7cfe5 (#1272) changed the release barrier, its Alchemy carry and docs/releases.md.
    assert.equal(shipAlone(merged("42c7cfe5b")).pass, true);
  },
);

test("passes product changes and release-path changes on their own", () => {
  assert.equal(shipAlone(["src/pool/worker.ts", "docs/pools.md"]).pass, true);
  assert.equal(shipAlone(["scripts/release/deploy.ts", "architecture/model/x.c4"]).pass, true);
  assert.equal(shipAlone(["scripts/release/deploy.ts", "src/pool/worker.ts"]).pass, false);
});
