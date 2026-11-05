import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const diagnosticFiles = new Set([
  "compiler-cache-host.log",
  "compiler-cache-production.json",
  "physical-state-digests.ndjson",
  "physical-provisioning-completed.json",
  "sso-idp.log",
]);

/** Copy selected regular evidence only; runtime package links and database state are never evidence. */
export function copyE2eEvidence(
  source: string,
  destination: string,
  options: { full?: boolean; skipExisting?: boolean } = {},
) {
  let files = 0;
  let bytes = 0;
  const visit = (directory: string, inReport = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        rel = relative(source, path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "scenarios" && !inReport) {
          for (const scenario of readdirSync(path, { withFileTypes: true }))
            if (scenario.isDirectory()) visit(join(path, scenario.name));
        } else if (
          inReport ||
          ["cloud", "local", "self-host", "report", "diagnostics"].includes(entry.name)
        )
          visit(path, inReport || entry.name === "report");
      } else if (
        entry.isFile() &&
        (inReport ||
          diagnosticFiles.has(entry.name) ||
          /^(?:evidence|results|result|run|trace-ids|retention)\.json$/.test(entry.name) ||
          /^(?:server|cloud[^/]*|[a-z-]*postgres)\.log$/.test(entry.name) ||
          (options.full && /\.(?:png|webm|mp4|zip)$/.test(entry.name)))
      ) {
        const output = join(destination, rel);
        if (options.skipExisting && existsSync(output)) {
          if (!lstatSync(output).isFile())
            throw new Error("Evidence destinations must be regular files");
          continue;
        }
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        copyFileSync(path, output);
        files++;
        bytes += lstatSync(path).size;
      }
    }
  };
  visit(source);
  return { files, bytes };
}
