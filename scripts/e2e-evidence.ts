import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { connectorDiagnostic } from "./ci/connector-diagnostics.mjs";

const diagnosticFiles = new Set([
  "environment.json",
  "change-journal.ndjson",
  "runtime-preboot.json",
  "runtime-launches.ndjson",
  "runtime-switches.ndjson",
  "compiler-cache-host.log",
  "compiler-cache-production.json",
  "physical-state-digests.ndjson",
  "physical-provisioning-completed.json",
  "sso-idp.log",
]);

/** Assertion captures share the connector scrubber; arbitrary values never enter retained reports. */
function assertionEvidence(path: string) {
  const unavailable = (input: string) => JSON.stringify({ version: 1, input, records: [] });
  if (lstatSync(path).size > 32 * 1024) return unavailable("too-large");
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return unavailable("malformed");
  }
  const envelope =
    input !== null &&
    typeof input === "object" &&
    "version" in input &&
    input.version === 1 &&
    "records" in input &&
    Array.isArray(input.records)
      ? input
      : undefined;
  const records = Array.isArray(input) ? input : envelope?.records;
  if (!records) return unavailable("malformed");
  if (
    envelope &&
    "input" in envelope &&
    (envelope.input === "malformed" || envelope.input === "too-large")
  )
    return unavailable(envelope.input);
  return JSON.stringify({
    version: 1,
    truncated:
      records.length > 8 ||
      Boolean(envelope && "truncated" in envelope && envelope.truncated === true),
    records: records.slice(0, 8).map((record) => connectorDiagnostic("assertion", record)),
  });
}

/** Copy selected regular evidence only; runtime package links and database state are never evidence. */
export function copyE2eEvidence(
  source: string,
  destination: string,
  options: { full?: boolean; skipExisting?: boolean } = {},
) {
  let files = 0;
  let bytes = 0;
  const visit = (directory: string, inReport = false, serverLogOnly = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        rel = relative(source, path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!inReport && entry.name.startsWith("development")) visit(path, false, true);
        else if (!serverLogOnly && entry.name === "scenarios" && !inReport) {
          for (const scenario of readdirSync(path, { withFileTypes: true }))
            if (scenario.isDirectory()) visit(join(path, scenario.name));
        } else if (
          !serverLogOnly &&
          (inReport ||
            ["cloud", "local", "self-host", "report", "diagnostics"].includes(entry.name))
        )
          visit(path, inReport || entry.name === "report");
      } else if (
        entry.isFile() &&
        (serverLogOnly
          ? entry.name === "server.log"
          : inReport ||
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
        if (inReport && entry.name === "assertion-diagnostics.json")
          writeFileSync(output, assertionEvidence(path), { mode: 0o600 });
        else copyFileSync(path, output);
        files++;
        bytes += lstatSync(path).size;
      }
    }
  };
  visit(source);
  return { files, bytes };
}
