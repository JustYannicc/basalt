import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../process.ts";

export function e2eCorrection(root: string) {
  const patch = join(root, "e2e/hitl-inventory-lifetime.patch");
  return existsSync(patch) ? patch : undefined;
}

/** Test-only corrections follow the carried scenarios without rewriting an immutable carry. */
export function prepareE2e(root: string, upstream: string) {
  const patch = e2eCorrection(root);
  if (patch === undefined) return;
  const applied = spawnSync("git", ["apply", "--reverse", "--check", patch], {
    cwd: upstream,
    stdio: "ignore",
  });
  if (applied.status === 0) return;
  run("git", ["apply", "--check", "--whitespace=error-all", patch], upstream);
  run("git", ["apply", "--whitespace=error-all", patch], upstream);
}
