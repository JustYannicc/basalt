import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { baselineProbeFailureRows } from "./baseline-probe-failure.ts";
import { baselineRoles } from "./baseline-probe.ts";
import { loadDeclaredChanges } from "./declared-file.ts";

/** The refusal settings-probe.ts's declaration load raises for this file content. */
async function declarationRefusal(content: string) {
  const root = await mkdtemp(join(tmpdir(), "baseline-probe-declarations-"));
  try {
    await writeFile(join(root, "release-declarations.json"), content);
    return await loadDeclaredChanges(root).then(
      () => assert.fail("a malformed declaration file loaded"),
      (error: unknown) => error,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [name, content] of [
  ["an unparseable", "{ not json"],
  ["an off-schema", JSON.stringify({ schemaVersion: 1, changes: [{ action: "drop-everything" }] })],
] as const)
  test(`${name} declarations file reports invalid-declaration-file, not a candidate inventory read`, async () => {
    const rows = baselineProbeFailureRows(await declarationRefusal(content), 7);
    assert.equal(rows.length, baselineRoles.length);
    for (const row of rows) {
      assert.deepEqual(
        { ok: row.ok, reason: row.reason, type: row.type, ms: row.ms },
        { ok: false, reason: "invalid-declaration-file", type: "BarrierRefusal", ms: 7 },
      );
      assert.equal("candidateFailure" in row, false);
    }
  });

test("an unclassified error is still reported as a candidate inventory read failure", () => {
  const [row] = baselineProbeFailureRows(new Error("synthetic"), 1);
  assert.equal(row!.ok, false);
  assert.ok("candidateFailure" in row!);
  assert.notEqual(row!.type, "BarrierRefusal");
});
