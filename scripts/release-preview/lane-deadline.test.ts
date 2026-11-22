import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { laneDeadline } from "./lane-deadline.ts";

const file = (lanes: Record<string, unknown>) => {
  const path = join(mkdtempSync(join(tmpdir(), "lane-deadline-")), "lanes.json");
  writeFileSync(path, JSON.stringify({ lanes }));
  return path;
};
const now = Date.parse("2026-11-22T06:00:00Z");

test("every job of a lane reads the same deadline, recorded once", () => {
  const path = file({ "7": "2026-11-22T18:00:00Z" });
  const first = laneDeadline(7, path, now);
  assert.equal(first, String(Date.parse("2026-11-22T18:00:00Z")));
  // An hour later the lane's deadline is the same value, so no secret moves between releases.
  assert.equal(laneDeadline(7, path, now + 3_600_000), first);
});

test("a lane with no deadline gets none, and a malformed or past one refuses", () => {
  assert.equal(laneDeadline(8, file({ "7": "2026-11-22T18:00:00Z" }), now), undefined);
  for (const bad of ["tomorrow", "2026-11-22T18:00Z", 1795398855000, "2026-11-22T05:00:00Z"])
    assert.throws(() => laneDeadline(7, file({ "7": bad }), now), /deadline/u, String(bad));
});

test("the repo's file parses and the workflow takes the lane's deadline, never a per-job one", async () => {
  const { readFileSync } = await import("node:fs");
  const repo = new URL("./lane-deadlines.json", import.meta.url).pathname;
  assert.doesNotThrow(() => laneDeadline(1, repo, now));
  const workflow = readFileSync(
    new URL("../../.github/workflows/stage-rehearsal.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /lane-deadline\.ts "\$lane"/u);
  // The only per-job value left is the destroy's fallback, which deploys nothing.
  const perJob = workflow.match(/\$\(\( \(\$\(date \+%s\) \+ 86400\) \* 1000 \)\)/gu) ?? [];
  assert.equal(perJob.length, 1);
  assert.match(workflow, /stage-destroy\*\) \[ -n "\$expires" \] \|\| expires=/u);
});
