import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function validateDependencyReport(status: number | null, stdout: string, stderr: string) {
  const fail = () => {
    throw new Error("Unexpected Playwright system dependency report");
  };
  if (stderr !== "") fail();
  if (status === 0) {
    if (stdout !== "All system dependencies are installed.\n") fail();
    return;
  }
  if (status !== 1) fail();
  const lines = stdout.split("\n");
  if (lines.pop() !== "") fail();
  const header = /^Missing system dependencies \(([1-9][0-9]*)\):$/.exec(lines.shift() ?? "");
  if (!header || Number(header[1]) !== lines.length) fail();
  if (new Set(lines).size !== lines.length) fail();
  if (!lines.every((line) => /^  [a-z0-9][a-z0-9+.-]+(?::[a-z0-9][a-z0-9-]*)?$/.test(line))) fail();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync("bunx", ["playwright", "install-deps", "--dry-run", "chromium"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  // Playwright 1.63 exits 1 for a complete missing-package report.
  validateDependencyReport(result.status, result.stdout, result.stderr);
  const fingerprint = createHash("sha256")
    .update(readFileSync("/etc/os-release"))
    .update(readFileSync("node_modules/playwright/package.json"))
    .update(result.stdout)
    .digest("hex");
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${fingerprint}\n`);
}
