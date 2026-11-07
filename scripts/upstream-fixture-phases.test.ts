import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("a real test watchdog reports the last milestone and outstanding fixture wait", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { test } from "node:test";
import { fixturePhases } from ${JSON.stringify(new URL("./upstream-fixture-phases.ts", import.meta.url).href)};
test("stalled fixture", { timeout: 25 }, async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  const phase = fixturePhases(t, "watchdog-proof");
  phase.reached("held");
  phase.reached("parent-exit");
  phase.waiting("replacement-published");
  await new Promise(() => {});
});
`,
    ],
    {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /test timed out after 25ms/);
  const diagnostics = result.stdout.split("\n").flatMap((line) => {
    const json = /\{"fixture":"watchdog-proof",.*\}/.exec(line)?.[0];
    if (!json) return [];
    const value = JSON.parse(json);
    return value.fixture === "watchdog-proof" ? [value] : [];
  });
  const aborted = diagnostics.find((value) => value.event === "aborted");
  assert.ok(aborted, "the watchdog must retain a phase snapshot before fixture cleanup");
  assert.equal(aborted.lastMilestone, "parent-exit");
  assert.equal(aborted.waitingFor, "replacement-published");
  assert.ok(aborted.elapsedMs >= 0);
  assert.ok(aborted.waitingMs >= 0);
});
