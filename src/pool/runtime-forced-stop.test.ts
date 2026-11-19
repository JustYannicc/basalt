import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { forcedStopGraceMs, supervisorStopGraceMs } from "./runtime-slots/forced-stop.ts";

test("a forced stop waits longer than the supervisor's own shutdown grace", async () => {
  const supervisor = await readFile(
    new URL("../../containers/pool/supervisor.py", import.meta.url),
    "utf8",
  );
  // terminate_children: SIGTERM, a grace, then kill and a one-second wait.
  const grace =
    /grace_until = time\.monotonic\(\) \+ remaining\(\d+ if deadline else (\d+)\)/u.exec(
      supervisor,
    );
  assert.ok(grace, "the supervisor's child grace moved: update supervisorStopGraceMs with it");
  assert.equal(supervisorStopGraceMs, (Number(grace[1]) + 1) * 1_000);
  assert.ok(
    forcedStopGraceMs > supervisorStopGraceMs,
    "destroy() must never cut into the supervisor's own grace",
  );
});
