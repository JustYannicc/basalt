import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { disableDashboardBatchAuthentication } from "./dashboard-batch-switch.ts";

const source = [
  'import { batchAuthentication } from "./batch-authentication.ts";',
  "export const hostedMiddlewareLive = Layer.mergeAll(",
  "  requireUserLive,",
  "  batchAuthentication.layer,",
  "  requireAccountTargetLive,",
  ");",
  "",
].join("\n");

test("profiling switches only batch caching and restores exact bytes after failure", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "dashboard-batch-switch-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "middleware.ts");
  const original = source.replaceAll("\n", "\r\n");
  writeFileSync(file, original);
  assert.throws(() => {
    const restore = disableDashboardBatchAuthentication(file);
    try {
      assert.equal(
        readFileSync(file, "utf8"),
        original.replace("  batchAuthentication.layer,\r\n", ""),
      );
      throw new Error("Baseline scenario failed");
    } finally {
      restore();
    }
  }, /Baseline scenario failed/);
  assert.equal(readFileSync(file, "utf8"), original);
});

for (const [name, original] of [
  ["missing", source.replace("  batchAuthentication.layer,\n", "")],
  [
    "duplicate",
    source.replace(
      "  batchAuthentication.layer,",
      "  batchAuthentication.layer,\n  batchAuthentication.layer,",
    ),
  ],
] as const) {
  test(`profiling refuses a ${name} middleware layer before changing source`, (context) => {
    const directory = mkdtempSync(join(tmpdir(), "dashboard-batch-switch-"));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "middleware.ts");
    writeFileSync(file, original);
    assert.throws(
      () => disableDashboardBatchAuthentication(file),
      /Expected one dashboard batch middleware layer/,
    );
    assert.equal(readFileSync(file, "utf8"), original);
  });
}

test("restoration refuses to overwrite a changed middleware file", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "dashboard-batch-switch-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "middleware.ts");
  writeFileSync(file, source);
  const restore = disableDashboardBatchAuthentication(file);
  const changed = readFileSync(file, "utf8") + "otherChange();\n";
  writeFileSync(file, changed);
  assert.throws(restore, /Dashboard batch middleware changed during profiling/);
  assert.equal(readFileSync(file, "utf8"), changed);
});
