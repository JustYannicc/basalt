import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/*
 * Downloads recent release runs' barrier receipts for the preflight. Only their
 * provider-observation.json is read, and only as a claim the controller then has to accept.
 */
const out = process.argv[2];
const repository = process.env.GITHUB_REPOSITORY;
if (!out || !repository) throw new Error("Usage: release-preflight-receipts.ts <directory>");
mkdirSync(out, { recursive: true });
const gh = (args: string[]) =>
  execFileSync("gh", [...args, "-R", repository], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
let found = 0;
for (const workflow of ["release-main.yml", "release-manual.yml", "deploy.yml"]) {
  let runs: { databaseId: number }[] = [];
  try {
    runs = JSON.parse(
      gh(["run", "list", "--workflow", workflow, "--limit", "15", "--json", "databaseId"]),
    );
  } catch {
    continue;
  }
  for (const { databaseId } of runs)
    try {
      gh([
        "run",
        "download",
        String(databaseId),
        "-n",
        "release-barrier",
        "-D",
        join(out, String(databaseId)),
      ]);
      found++;
    } catch {
      // Runs that stopped before the barrier have no receipts.
    }
}
console.log(`Release receipts downloaded from ${found} run(s).`);
