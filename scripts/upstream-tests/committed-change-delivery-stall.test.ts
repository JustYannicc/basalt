import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const path = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// The subject is the real lone-commit test under its own five-second deadline; only its
// delivery worker is replaced, so the timeout report it prints is the one CI would show.
test("a lone-commit delivery timeout names the stalled phase and revisions", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      path("./committed-change-delivery-stall-hooks.ts"),
      path("./committed-change-delivery.test.ts"),
    ],
    // Without the runner's context the subject prints its own report instead of serialized events.
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.match(output, /replaced by a worker that delivers only revision 1/, output);
  assert.equal(result.signal, null, output);
  assert.equal(result.status, 1, output);
  assert.match(output, /test timed out after 5000ms/, output);
  const events = output.split("\n").flatMap((line) => {
    const json = /\{"fixture":"lone-commit-delivery",.*\}/.exec(line)?.[0];
    return json ? [JSON.parse(json)] : [];
  });
  const aborted = events.find((event) => event.event === "aborted");
  assert.ok(aborted, output);
  assert.equal(aborted.waitingFor, "delivery of revision 2");
  assert.equal(aborted.lastMilestone, "commit of revision 2");
  assert.deepEqual(
    events
      .filter((event) => event.lastMilestone.startsWith("worker delivered"))
      .map((event) => event.lastMilestone),
    ["worker delivered revision 1"],
  );
});
