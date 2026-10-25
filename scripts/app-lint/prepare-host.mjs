/** Read the pinned host's framework manifest and apply its carried patches without installing the host. */
import { hostSourceDigest } from "./host.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
if (
  pin.repository !== "https://github.com/UsefulSoftwareCo/executor.git" ||
  !/^[a-f0-9]{40}$/.test(pin.commit)
)
  throw new Error("Expected the public tools service and an immutable source pin");
const scratch = mkdtempSync(join(tmpdir(), "executor-app-host-"));
try {
  const path = join(scratch, "packages/apps/package.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    execFileSync("gh", [
      "api",
      `repos/UsefulSoftwareCo/executor/contents/packages/apps/package.json?ref=${pin.commit}`,
      "-H",
      "Accept: application/vnd.github.raw+json",
    ]),
  );
  execFileSync("git", ["init", "--quiet", scratch]);
  for (const patch of readdirSync(join(root, "patches"))
    .filter((name) => name.endsWith(".patch"))
    .sort())
    execFileSync(
      "git",
      ["apply", "--include=packages/apps/package.json", join(root, "patches", patch)],
      { cwd: scratch },
    );
  const destination = join(root, ".ci-tools/app-lint-host.json");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(
    destination,
    JSON.stringify({
      source: hostSourceDigest(root),
      manifest: JSON.parse(readFileSync(path, "utf8")),
    }),
  );
  console.log("Prepared the framework manifest from the pinned host and carried patches.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
