import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaselineInventoryError, baselineInventory, baselineRoles } from "./baseline-probe.ts";
import { reportBaselineProbe } from "./baseline-probe-report.ts";

test("every inventory refusal reaches the job error, summary and safe receipt", async (context) => {
  const scripts = baselineRoles
    .filter((role) => !["Api", "PublicSite"].includes(role))
    .map((role) => ({
      id: `basalt-${role.toLowerCase()}-production-fixture`,
      tags: ["alchemy:stack:basalt", "alchemy:stage:production", `alchemy:id:${role}`],
    }));
  scripts.push(
    {
      id: "basalt-router-production-second",
      tags: ["alchemy:stack:basalt", "alchemy:stage:production", "alchemy:id:Router"],
    },
    {
      id: "basalt-privatefixture-production-fixture",
      tags: ["alchemy:stack:basalt", "alchemy:stage:production", "alchemy:id:Private"],
    },
  );
  let refusal: BaselineInventoryError | undefined;
  try {
    baselineInventory(scripts);
  } catch (error) {
    assert.ok(error instanceof BaselineInventoryError);
    refusal = error;
  }
  assert.ok(refusal);
  assert.deepEqual(
    refusal.refusals.map((item) => item.role),
    ["Api", "PublicSite", "Router", "(inventory)"],
  );
  const failures = refusal.refusals.map((item) => ({
    ...item,
    type: "BaselineInventoryError",
    ok: false,
    status: null,
    bytes: 0,
    ms: 1,
    attempts: 0,
  }));
  const rows = [
    ...refusal.workers.map(({ role }) => ({
      role,
      ok: true,
      status: 200,
      bytes: 10,
      ms: 1,
      attempts: 1,
    })),
    ...failures,
  ];
  assert.equal(rows.length, 21);
  const root = await mkdtemp(join(tmpdir(), "baseline-report-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "receipt.json"),
    summary = join(root, "summary.md");
  const logs: string[] = [],
    errors: string[] = [];
  await reportBaselineProbe(rows, output, summary, {
    log: (value) => logs.push(value),
    error: (value) => errors.push(value),
  });
  const retained = await readFile(output, "utf8");
  const text = await readFile(summary, "utf8");
  assert.deepEqual(JSON.parse(retained), rows);
  assert.equal(logs.join("\n") + "\n", text);
  assert.equal(errors.length, 4);
  for (const row of rows) assert.ok(text.includes(`| ${row.role} |`));
  for (const row of failures) {
    assert.ok(text.includes(row.reason));
    assert.ok(
      errors.some(
        (line) =>
          line.startsWith("::error::") && line.includes(row.role) && line.includes(row.reason),
      ),
    );
  }
  assert.doesNotMatch(
    retained + text + errors.join("\n"),
    /privatefixture|basalt-|production-fixture/,
  );
  assert.match(text, /target sha256:[a-f0-9]{64}/);
});
