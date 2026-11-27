// The release entry's call, and its own public lines from what it prints: its progress events
// (only short identifying fields), its applied line, its failure report and the refusals it throws
// before it starts. Anything else a child process prints is dropped, so no provider text reaches
// the log.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
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

/**
 * Every progress tag Alchemy 2.0.0-beta.80 emits, exactly as its event union declares them
 * (alchemy/src/Report.ts). A dotted tag is shown only when it is one of these, so no hostname can
 * pass as a tag; any other value goes through the dot-free identifier rule like every other field.
 */
export const progressTags = Object.freeze([
  "apply.resource.note",
  "apply.resource.status",
  "plan.resource.started",
  "plan.resource.completed",
  "plan.action.completed",
  "plan.phase",
  "state.bootstrap.started",
  "state.bootstrap.completed",
  "nuke.scan.started",
  "nuke.scan.provider.started",
  "nuke.pass.started",
  "nuke.scan.provider.completed",
  "nuke.resource.deleted",
  "nuke.resource.failed",
  "provider.configure.started",
  "provider.configure.completed",
  "provider.refresh.started",
  "provider.refresh.completed",
]);
// The set is private, so nothing that imports the list can add to what passes.
const progressTagSet = new Set(progressTags);

/**
 * The event a line holds, re-serialised from what was checked, or undefined. The line itself is
 * never printed: a duplicate key or an escape would make its text differ from the parsed object.
 */
const publicEvent = (line) => {
  if (!line.startsWith("{")) return undefined;
  try {
    const event = JSON.parse(line);
    const shown =
      event !== null &&
      typeof event === "object" &&
      !Array.isArray(event) &&
      Object.entries(event).every(
        ([key, value]) =>
          EVENT_KEYS.has(key) &&
          (typeof value === "string"
            ? IDENTIFIER.test(value) || (key === "_tag" && progressTagSet.has(value))
            : Number.isFinite(value) || typeof value === "boolean"),
      );
    return shown ? JSON.stringify(event) : undefined;
  } catch {
    return undefined;
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
      } else {
        const event = publicEvent(line);
        if (event !== undefined) kept.push(event);
        else if (applied.test(line) || refusals.has(line)) kept.push(line);
      }
    }
  }
  return kept.filter((line) => !ACCOUNT_ID.test(line));
}

// The entry keeps a failure's full message here, in the job's own checkout (deploy.ts keepPrivate).
const failureDetail = ".local/release/failure.txt";
// A name from our own source: a class, a command or a field. No dot, slash, space or digit run.
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const named = (value) => (NAME.test(value ?? "") && !ACCOUNT_ID.test(value) ? value : undefined);
// A wire guard field names what was refused, from scripts/release/wire-guard.ts: one of its own
// words, then at most a metadata key or an export's class. Anything else is not printed as one.
const WIRE_FIELD =
  /^(?:metadata|bindings|main_module|name|durable_objects|method|host|path|migrations\.[a-z_]{1,40}|exports\.[A-Za-z][A-Za-z0-9]{0,63}\.state)$/u;

/**
 * One public line for a failed entry, from a closed set, read from its private detail. Only
 * numbers and names matched by fixed patterns are printed; the message itself never is.
 */
export function releaseCause(detail) {
  if (typeof detail !== "string" || !detail) return "release cause: no_detail";
  const version = /State store version (\d{1,3}), expected (\d{1,3})\b/u.exec(detail);
  if (version)
    return `release cause: state_store_version store=${version[1]} expected=${version[2]}`;
  const wire = /wire guard refused [A-Z]{3,7} \S+ \([^)]{1,80}\): ([^\s=]{1,80}) = /u.exec(detail);
  if (wire && WIRE_FIELD.test(wire[1]) && !ACCOUNT_ID.test(wire[1]))
    return `release cause: wire_refused field=${wire[1]}`;
  if (/\bUnauthorized\b|Authentication failed/u.test(detail)) return "release cause: unauthorized";
  const head = /^Release stopped(?: in ([^\s:]+))?(?: at [^\n]*?)?: ([^\s(]+) \(/u.exec(detail);
  const step = named(head?.[1]) ?? "unknown";
  const errorClass = named(head?.[2]) ?? "unknown";
  return `release cause: unclassified class=${errorClass} step=${step}`;
}

const readDetail = () => {
  try {
    return readFileSync(failureDetail, "utf8");
  } catch {
    return undefined;
  }
};

/** Applies the stage through the release entry, which never redeploys the shared State store. */
export function runEntry(deleteBy, env = process.env) {
  // A detail left by an earlier run in this checkout must not name this run's cause; if it cannot be
  // removed, this run names none.
  let detailUsable = true;
  try {
    rmSync(failureDetail, { force: true });
  } catch {
    detailUsable = false;
  }
  const result = spawnSync("bun", [entry, "deploy", "--stage", stage, "--config", entryConfig], {
    cwd: ".upstream/apps/hosted/cloud",
    env: { ...env, ALCHEMY_STAGE: stage, EMULATED_DELETE_BY: String(deleteBy) },
    encoding: "utf8",
    timeout: 15 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const line of publicEntryLines(result.stdout ?? "", result.stderr ?? "")) console.log(line);
  if (result.status !== 0) console.log(releaseCause(detailUsable ? readDetail() : undefined));
  if (result.status !== 0)
    throw new StageError(
      `The release entry's deploy exited with ${result.status ?? result.signal ?? "no status"}; its public lines are above, its detail stays private`,
    );
}
