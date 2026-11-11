import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "./catalog-source-artifacts.ts";
import type { CatalogSourceApp } from "./catalog-sources.ts";

// The candidate's own hashes cannot vouch for a new pin. Only provenance already
// reviewed on the target branch may skip remote verification.
export async function sourcesNeedingVerification(
  root: string,
  apps: CatalogSourceApp[],
  baseRef: string,
): Promise<CatalogSourceApp[]> {
  let base: string;
  try {
    base = execFileSync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    return apps;
  }
  const changed: CatalogSourceApp[] = [];
  for (const app of apps) {
    const path = `src/catalog/${app.package}/provenance.json`;
    let trusted: unknown;
    try {
      trusted = JSON.parse(
        execFileSync("git", ["show", `${base}:${path}`], {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch {
      changed.push(app);
      continue;
    }
    const current: unknown = JSON.parse(await readFile(join(root, path), "utf8"));
    if (
      !isRecord(trusted) ||
      !isRecord(current) ||
      !isRecord(trusted.catalogSource) ||
      !isDeepStrictEqual(trusted.catalogSource, current.catalogSource)
    )
      changed.push(app);
  }
  return changed;
}
