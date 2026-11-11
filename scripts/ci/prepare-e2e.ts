import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../process.ts";

export function e2eCorrections(root: string) {
  return [
    "hitl-inventory-lifetime",
    "webhook-removal-recovery",
    "atlassian-fixture-preparation",
    "sso-billing-settlement",
  ]
    .map((name) => join(root, `e2e/${name}.patch`))
    .filter(existsSync);
}

/** Test-only corrections follow the carried scenarios without rewriting an immutable carry. */
export function prepareE2e(root: string, upstream: string) {
  for (const patch of e2eCorrections(root)) {
    const applied = spawnSync("git", ["apply", "--reverse", "--check", patch], {
      cwd: upstream,
      stdio: "ignore",
    });
    if (applied.status === 0) continue;
    run("git", ["apply", "--check", "--whitespace=error-all", patch], upstream);
    run("git", ["apply", "--whitespace=error-all", patch], upstream);
  }
}
