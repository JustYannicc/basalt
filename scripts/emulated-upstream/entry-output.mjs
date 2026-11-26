// The release entry's call, and its own public lines from what it prints: its progress events
// (only short identifying fields), its applied line, its failure report and the refusals it throws
// before it starts. Anything else a child process prints is dropped, so no provider text reaches
// the log.
import { spawnSync } from "node:child_process";
import { StageError } from "./public-error.mjs";
import { stage } from "./settings.ts";

// The entry runs from the cloud app; both paths are relative to it.
const entry = "../../../../scripts/release/deploy.ts";
export const entryConfig = "../../../../scripts/emulated-upstream/stack.ts";

const EVENT_KEYS = new Set([
  "_tag",
  "id",
  "fqn",
  "logicalId",
  "status",
  "phase",
  "action",
  "resourceType",
  "kind",
]);
// A short identifier: no URL, no message, no path, and no dot, so no hostname either.
const IDENTIFIER = /^[A-Za-z0-9_:-]{1,64}$/u;
// A Cloudflare account id; a 64-hex digest is longer and stays.
const ACCOUNT_ID = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/iu;

/**
 * The refusals scripts/release/deploy.ts throws before its try, in its own words (the runtime
 * prints `error: <message>`). A test reads them back from that file.
 */
export const entryRefusals = [
  "Production releases run only in GitHub Actions on an immutable candidate",
  "Production is never destroyed",
  "Production applies only a reviewed plan digest",
  "Use --stage production, a disposable test-* stage, or scale-<n> for the scale stack",
  "A rehearsal stage is exactly test-rehearsal-<n>, n from 1 to 9",
  "A teardown runs only on a test-rehearsal-<n> stage",
  // scripts/release/stack-config.ts, for the one config this stage passes.
  `Unknown stack config ${entryConfig}`,
];
const refusals = new Set(entryRefusals.map((message) => `error: ${message}`));

const isEvent = (line) => {
  if (!line.startsWith("{")) return false;
  try {
    const event = JSON.parse(line);
    return (
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      Object.entries(event).every(
        ([key, value]) =>
          EVENT_KEYS.has(key) &&
          (typeof value === "string"
            ? IDENTIFIER.test(value)
            : Number.isFinite(value) || typeof value === "boolean"),
      )
    );
  } catch {
    return false;
  }
};
const applied =
  /^(?:Planned|Applied; a fresh plan is all noop): digest `[A-Za-z0-9:._-]{1,128}`, attempt `[A-Za-z0-9._-]{1,64}`$/u;

export function publicEntryLines(stdout = "", stderr = "") {
  const kept = [];
  // The entry prints its failure report to both streams; it is shown once.
  const reported = new Set();
  for (const stream of [stdout, stderr]) {
    let report = false;
    for (const line of stream.split(/\r?\n/u)) {
      // The entry's failure report: its head line, then one `- ` line per public cause.
      if (line.startsWith("Release stopped")) report = true;
      else if (!(report && line.startsWith("- "))) report = false;
      if (report) {
        if (!reported.has(line)) kept.push(line);
        reported.add(line);
      } else if (isEvent(line) || applied.test(line) || refusals.has(line)) kept.push(line);
    }
  }
  return kept.filter((line) => !ACCOUNT_ID.test(line));
}

/** Applies the stage through the release entry, which never redeploys the shared State store. */
export function runEntry(deleteBy, env = process.env) {
  const result = spawnSync("bun", [entry, "deploy", "--stage", stage, "--config", entryConfig], {
    cwd: ".upstream/apps/hosted/cloud",
    env: { ...env, ALCHEMY_STAGE: stage, EMULATED_DELETE_BY: String(deleteBy) },
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const line of publicEntryLines(result.stdout ?? "", result.stderr ?? "")) console.log(line);
  if (result.status !== 0)
    throw new StageError(
      `The release entry's deploy exited with ${result.status ?? result.signal ?? "no status"}; its public lines are above, its detail stays private`,
    );
}
