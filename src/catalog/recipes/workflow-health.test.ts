import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowHealthCondition } from "../../../recipes/operator/workflow-health-condition.ts";
const now = Date.UTC(2026, 9, 31, 12);
const expected = [{ name: "check", maximumAgeMinutes: 10 }];
const configuredAt = now - 3600000;
const success = { workflow: "check", checkedAt: now - 60000, successfulAt: now - 60000, known: 1 };
test("live delivery failure survives incomplete scan metadata", () => {
  assert.equal(workflowHealthCondition(now, configuredAt, expected, [success], []), "healthy");
  for (const status of ["uncertain", "refused", "claimed", "submitted"])
    assert.equal(
      workflowHealthCondition(
        now,
        configuredAt,
        expected,
        [],
        [{ status, at: now - 61000 }],
        false,
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
  assert.equal(
    workflowHealthCondition(now, configuredAt, expected, [success], [], false),
    "unknown",
  );
});
test("current scan timestamps detect stalls without waiting for human responses or reading history", () => {
  assert.equal(workflowHealthCondition(now, configuredAt, expected, [success], []), "healthy");
  assert.equal(
    workflowHealthCondition(
      now,
      configuredAt,
      expected,
      [{ ...success, successfulAt: now - 660000 }],
      [],
    ),
    "action",
  );
  assert.equal(workflowHealthCondition(now, configuredAt, expected, [], []), "action");
  assert.equal(workflowHealthCondition(now, now - 60000, expected, [], []), "unknown");
});
test("unknown reads cannot claim health; every configured workflow must stay fresh", () => {
  assert.equal(
    workflowHealthCondition(
      now,
      configuredAt,
      expected,
      [{ ...success, checkedAt: now, known: 0 }],
      [],
    ),
    "unknown",
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
  assert.equal(
    workflowHealthCondition(
      now,
      configuredAt,
      expected,
      [{ ...success, successfulAt: 0, known: 0 }],
      [],
    ),
    "action",
  );
});
