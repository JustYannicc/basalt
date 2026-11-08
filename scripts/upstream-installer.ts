import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withDependencyStoreLock } from "./upstream-store.ts";
import { currentProcessOwner } from "./process-owner.ts";

const attempt = process.argv[2];
if (!attempt) throw new Error("Expected a private dependency attempt");
const token = process.env.BASALT_DEPENDENCY_INSTALLER;
if (!token) throw new Error("Expected an installer incarnation token");
// Publication and collection cannot race this lease claim. Every lifecycle child inherits this group.
await withDependencyStoreLock(() => {
  writeFileSync(
    join(attempt, "installer.json"),
    JSON.stringify({
      ...currentProcessOwner(),
      group: process.pid,
      token,
    }),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
});
const result = spawnSync("bun", ["install", "--frozen-lockfile", "--backend=copyfile"], {
  cwd: attempt,
  stdio: "inherit",
  env: {
    ...process.env,
    ...(process.env.BASALT_CI_OMIT_RELEASE_DOWNLOADS === "true"
      ? {
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(fileURLToPath(new URL("./ci/deny-release-downloads.cjs", import.meta.url)))}`,
        }
      : {}),
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
