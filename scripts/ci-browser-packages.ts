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

const dryRun = () => {
  const result = spawnSync("bunx", ["playwright", "install-deps", "--dry-run", "chromium"], {
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result;
};

/**
 * The deb cache key, computed offline: the OS release, the pinned Playwright, the architecture and
 * the runner image, which self-hosted runners may leave unset.
 * The prefix without the image version lets a new image start from the last one's packages.
 */
export function packageCacheKey(
  osRelease: string,
  playwright: string,
  architecture: string,
  image: string,
  version: string,
) {
  const base = createHash("sha256")
    .update(osRelease)
    .update(playwright)
    .update(architecture)
    .update(image)
    .digest("hex");
  const prefix = `playwright-debs-v2-${base.slice(0, 32)}-`;
  return { prefix, key: prefix + createHash("sha256").update(version).digest("hex").slice(0, 16) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
  const result = dryRun();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (process.argv[2] === "key") {
    // Before any index refresh: installed state and the image's existing apt lists, no network.
    const complete =
      result.status === 0 &&
      result.stdout === "All system dependencies are installed.\n" &&
      result.stderr === "";
    const { prefix, key } = packageCacheKey(
      readFileSync("/etc/os-release", "utf8"),
      readFileSync("node_modules/playwright/package.json", "utf8"),
      process.arch,
      process.env.ImageOS ?? "",
      process.env.ImageVersion ?? "",
    );
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `complete=${complete}\nkey=${key}\nprefix=${prefix}\n`,
    );
  } else {
    // After a refresh: Playwright 1.63 exits 1 for a complete missing-package report.
    validateDependencyReport(result.status, result.stdout, result.stderr);
  }
}
