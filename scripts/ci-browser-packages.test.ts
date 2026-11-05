import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDependencyReport } from "./ci-browser-packages.ts";

const report = "Missing system dependencies (2):\n  fonts-liberation\n  libnss3\n";

for (const [name, stdout] of [
  ["header-only", "Missing system dependencies (2):\n"],
  [
    "changed body format",
    "Missing system dependencies (2):\n  packages=[fonts-liberation,libnss3]\n",
  ],
  ["count mismatch", report.replace("(2)", "(3)")],
  ["extra package", report + "  xvfb\n"],
  ["duplicate package", report.replace("libnss3", "fonts-liberation")],
  ["unexpected line between packages", report.replace("  libnss3", "apt failed\n  libnss3")],
  ["unexpected prefix", "apt failed\n" + report],
  ["unexpected suffix", report + "apt failed\n"],
  ["empty package set", "Missing system dependencies (0):\n"],
]) {
  test(`Playwright dependency report rejects ${name}`, () => {
    assert.throws(() => validateDependencyReport(1, stdout, ""), /Unexpected Playwright/);
  });
}

test("Playwright 1.63 missing-dependencies report passes", () => {
  assert.doesNotThrow(() => validateDependencyReport(1, report, ""));
});

test("a valid report cannot hide stderr failures or an unexpected exit status", () => {
  assert.throws(() => validateDependencyReport(1, report, "apt failed\n"), /Unexpected Playwright/);
  assert.throws(() => validateDependencyReport(2, report, ""), /Unexpected Playwright/);
  assert.throws(() => validateDependencyReport(null, report, ""), /Unexpected Playwright/);
});

test("installed dependencies require the exact successful Playwright report", () => {
  assert.doesNotThrow(() =>
    validateDependencyReport(0, "All system dependencies are installed.\n", ""),
  );
  assert.throws(() => validateDependencyReport(0, report, ""), /Unexpected Playwright/);
});
