import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowHealthCondition } from "../../../recipes/operator/workflow-health-condition.ts";
const now = Date.UTC(2026, 9, 31, 12);
const expected = [{ name: "check", maximumAgeMinutes: 10 }];
const configuredAt = now - 3600000;
const success = { workflow: "check", at: now - 60000, status: "complete", outcome: "healthy" };
test("workflow health reads nested delivery failures and live unresolved delivery attempts", () => {
  assert.equal(workflowHealthCondition(now, configuredAt, expected, [success], []), "healthy");
  for (const status of ["delivery-uncertain", "delivery-refused"])
    assert.equal(
      workflowHealthCondition(
        now,
        configuredAt,
        expected,
        [{ ...success, outcome: "declined", delivery: status }],
        [],
      ),
      "action",
    );
  for (const status of ["uncertain", "refused", "claimed", "submitted"])
    assert.equal(
      workflowHealthCondition(
        now,
        configuredAt,
        expected,
        [success],
        [{ status, at: now - 61000 }],
      ),
      "action",
    );
  assert.equal(
    workflowHealthCondition(
      now,
      configuredAt,
      expected,
      [success],
      [{ status: "submitted", at: now }],
    ),
    "healthy",
  );
});
test("a legitimate human wait does not replace the expected successful scan cadence", () => {
  const waiting = { workflow: "check", at: now, status: "running" };
  assert.equal(
    workflowHealthCondition(now, configuredAt, expected, [success, waiting], []),
    "healthy",
  );
  assert.equal(
    workflowHealthCondition(
      now,
      configuredAt,
      expected,
      [{ ...success, at: now - 660000 }, waiting],
      [],
    ),
    "action",
  );
  assert.equal(workflowHealthCondition(now, configuredAt, expected, [waiting], []), "action");
  assert.equal(workflowHealthCondition(now, now - 60000, expected, [waiting], []), "unknown");
});
test("unknown outcomes never claim success, and a newer successful scan recovers a failed run", () => {
  const failed = { workflow: "check", at: now - 120000, status: "errored" };
  assert.equal(
    workflowHealthCondition(now, configuredAt, expected, [failed, success], []),
    "healthy",
  );
  assert.equal(
    workflowHealthCondition(now, configuredAt, expected, [{ ...success, outcome: "unknown" }], []),
    "action",
  );
  assert.equal(
    workflowHealthCondition(
      now,
      configuredAt,
      [...expected, { name: "missing", maximumAgeMinutes: 10 }],
      [success],
      [],
    ),
    "action",
  );
});
