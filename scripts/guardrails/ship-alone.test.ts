import assert from "node:assert/strict";
import { test } from "node:test";
import { shipAlone } from "./ship-alone.ts";
import { git, measured } from "./test/history.ts";

// Files a merge into main brought in, compared with main before it.
const merged = (sha: string) =>
  git(["diff", "--name-only", "--no-renames", `${sha}^1`, sha])
    .split("\n")
    .filter(Boolean);

test("refuses the 16 Nov batch that replaced the release path alongside pool features", () => {
  const result = shipAlone(merged("dae3b3278"), measured);
  assert.equal(result.pass, false);
  assert.equal(result.releasePath.length, 127);
  assert.ok(result.other.some((file) => file.startsWith("src/pool/")));
});

test("passes a release fix that touches only the release path, its carries model and docs", () => {
  // 42c7cfe5 (#1272) changed the release barrier, its Alchemy carry and docs/releases.md.
  assert.equal(shipAlone(merged("42c7cfe5b"), measured).pass, true);
});

test("passes product changes and release-path changes on their own", () => {
  assert.equal(shipAlone(["src/pool/worker.ts", "docs/pools.md"]).pass, true);
  assert.equal(shipAlone(["scripts/release/deploy.ts", "architecture/model/x.c4"]).pass, true);
  assert.equal(shipAlone(["scripts/release/deploy.ts", "src/pool/worker.ts"]).pass, false);
});

test("a change that drops a path from the list is still judged by the list it changes", () => {
  const narrowed = measured.filter((path) => path !== "scripts/release-barrier/**");
  const files = ["scripts/release-barrier/entry.ts", "src/pool/worker.ts"];
  assert.equal(shipAlone(files, narrowed).pass, true);
  assert.equal(shipAlone(files, [...new Set([...narrowed, ...measured])]).pass, false);
});
