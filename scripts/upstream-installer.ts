import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withDependencyStoreLock } from "./upstream-store.ts";

const attempt = process.argv[2];
if (!attempt) throw new Error("Expected a private dependency attempt");
// Publication and collection cannot race this lease claim. Every lifecycle child inherits this group.
await withDependencyStoreLock(() => {
  writeFileSync(join(attempt, "installer.json"), JSON.stringify({ group: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
});
const result = spawnSync("bun", ["install", "--frozen-lockfile", "--backend=copyfile"], {
  cwd: attempt,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
