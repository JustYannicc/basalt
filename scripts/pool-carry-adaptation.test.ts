import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(`../containers/pool/${path}`, import.meta.url), "utf8");

test("the node context adaptation preserves the original submission code and regression assertions", () => {
  const original = read("retired/0611-node-generation-submission.patch");
  const adapted = read("patches/0642-node-generation-submission.patch");
  assert.equal(
    createHash("sha256").update(original).digest("hex"),
    "10d0e78169a3fdd262e77742963b830c49fc3b60c2424d4a3692079938c309b0",
  );
  const edits = (patch: string) =>
    patch.split("\n").filter((line) => line.startsWith("diff --git ") || /^[+-]/.test(line));
  assert.deepEqual(edits(adapted), edits(original));
});
