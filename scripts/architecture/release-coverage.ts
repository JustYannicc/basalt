import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { knownUncovered } from "../release-barrier/release-coverage/debt.ts";
import { releaseFailures } from "../release-barrier/release-coverage/failures.ts";
import { preflightCoverage } from "../release-barrier/release-coverage/preflight.ts";
import { regressionCoverage } from "../release-barrier/release-coverage/regressions.ts";
import { rehearsalCoverage } from "../release-barrier/release-coverage/rehearsal.ts";
import { execFileSync } from "node:child_process";
import { barrierRefusalSites } from "./release-refusals.ts";
import {
  releaseSteps,
  type Coverage,
  type ReleaseStepId,
} from "../release-barrier/release-coverage/steps.ts";

/**
 * Every release step must be driven by a regression scenario, the preflight or the rehearsal.
 * `knownUncovered` is the debt that existed when the gate landed: it may only shrink, so a step
 * added after it can't merge untested.
 */
export function releaseCoverageGaps(root: string) {
  const sites = barrierRefusalSites(root);
  const steps = releaseSteps([...sites.keys()].sort());
  const known = new Set(steps);
  const all: readonly Coverage[] = [
    ...regressionCoverage,
    ...preflightCoverage,
    ...rehearsalCoverage,
  ];
  const covered = new Set([
    ...all.map((entry) => entry.step),
    ...releaseFailures.flatMap((failure) => failure.steps ?? []),
  ]);
  const debt = new Set<ReleaseStepId>(knownUncovered);
  const files = new Map<string, string | undefined>();
  const read = (path: string) => {
    if (!files.has(path))
      files.set(path, existsSync(path) ? readFileSync(path, "utf8") : undefined);
    return files.get(path);
  };
  // An entry whose change hasn't merged: its step and proof file arrive together.
  const pending = (entry: Coverage) =>
    entry.landsWith !== undefined && read(proofPath(root, entry.proof)) === undefined;
  return {
    steps,
    debt: knownUncovered.length,
    uncovered: steps
      .filter((step) => !covered.has(step) && !debt.has(step))
      .map((step) => `${step} (from ${origin(root, step, sites)})`),
    // A debt entry that is now covered, or no longer a step, must leave the list.
    settledDebt: knownUncovered.filter((step) => covered.has(step) || !known.has(step)),
    unknownSteps: all
      .filter((entry) => !known.has(entry.step) && !pending(entry))
      .map((entry) => entry.step),
    // Every past production failure keeps a proof; a pending one is checked once its file lands.
    missingFailureProofs: releaseFailures
      .filter((failure) => !failureProofHolds(read, root, failure))
      .map((failure) => `${failure.slug} -> ${failure.proof}`),
    // A regression entry names the test that proves it; the test must exist and say what it guards.
    missingProofs: regressionCoverage
      .filter((entry) =>
        entry.landsWith === undefined
          ? !proofExists(read, root, entry.proof)
          : !pending(entry) && !landedProofHolds(read, root, entry.proof),
      )
      .map((entry) => `${entry.step} -> ${entry.proof}`),
    // A phase test that swaps the release client for a stand-in never runs the real health() or
    // witness readback, so a phase or command proven that way is untested.
    bypassedClient: regressionCoverage
      .filter(
        (entry) => /^(?:phase|command):/.test(entry.step) && proofExists(read, root, entry.proof),
      )
      .filter((entry) => !throughReleaseClient(read, root, entry))
      .map((entry) => `${entry.step} -> ${entry.proof}`),
  };
}

const stepSources = {
  command: "src/pool/runtime-slots/handoff-command.ts",
  operation: "scripts/release-barrier/operation-failure.ts",
  phase: "scripts/release-barrier/runtime-image-release-phases.ts or barrier.ts",
} as const;

/**
 * Where an uncovered step comes from, so whoever composes a batch can tell which change owes the
 * proof: the line that raises it and, when git history is available, the commit that added it.
 */
function origin(root: string, step: ReleaseStepId, sites: ReadonlyMap<string, string>) {
  const [kind, ...rest] = step.split(":");
  const site = kind === "refusal" ? sites.get(rest.join(":")) : undefined;
  if (!site) return stepSources[kind as keyof typeof stepSources] ?? "unknown";
  const [file, line] = site.split(":");
  try {
    const commit = execFileSync(
      "git",
      ["-C", root, "log", "-1", "--format=%h %s", `-L${line},${line}:${file}`, "--no-patch"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    ).trim();
    return commit ? `${site}, added in ${commit}` : site;
  } catch {
    return site;
  }
}

/** A test that redirects or mocks the release client module never runs its real commands. */
export function redirectsReleaseClient(source: string) {
  return (
    /\b(?:registerHooks|mock\.module|vi\.(?:do)?[mM]ock)\b/.test(source) &&
    /["'`][^"'`]*runtime-release-client(?:\.ts)?["'`]/.test(source)
  );
}

type Read = (path: string) => string | undefined;

/**
 * A redirected client still counts when its stand-in wraps the real `runtimeReleaseClient` and lists
 * the commands it answers itself in `standInCommandActions`; those commands stay unproven.
 */
function throughReleaseClient(read: Read, root: string, entry: Coverage) {
  const path = proofPath(root, entry.proof);
  const source = read(path)!;
  if (!redirectsReleaseClient(source)) return true;
  for (const [, target] of source.matchAll(
    /new URL\(["'](\.[^"']+\.ts)["'], import\.meta\.url\)/g,
  )) {
    const text = read(join(dirname(path), target!));
    const replaced = text && /standInCommandActions = \[([^\]]*)\]/.exec(text);
    if (
      !replaced ||
      !/runtimeReleaseClient as \w+[^;]*from "\.\.\/runtime-release-client\.ts"/s.test(text)
    )
      continue;
    const actions = [...replaced[1]!.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    return !actions.some((action) => entry.step === `command:${action}`);
  }
  return false;
}

function failureProofHolds(read: Read, root: string, failure: (typeof releaseFailures)[number]) {
  const [, name] = failure.proof.split("#");
  const source = read(proofPath(root, failure.proof));
  if (source === undefined) return failure.landsWith !== undefined;
  return name === undefined || declaresTest(source, name);
}

const cataloged = new Set(releaseFailures.map((failure) => failure.proof.split("#")[0]!));

/** A landed proof from another change carries no marker of ours; it must still declare the test. */
function landedProofHolds(read: Read, root: string, proof: string) {
  const [, name] = proof.split("#");
  const source = read(proofPath(root, proof));
  return source !== undefined && (name === undefined || declaresTest(source, name));
}

/** The proof's file carries a `// Regression:` marker and still declares the named test. */
function proofExists(read: Read, root: string, proof: string) {
  const [, name] = proof.split("#");
  const source = read(proofPath(root, proof));
  return (
    source !== undefined &&
    // A test outside scripts/ stays unmarked (marking it is a runtime change); the catalog names it.
    (/\/\/ Regression: /.test(source) || cataloged.has(proof.split("#")[0]!)) &&
    (name === undefined || declaresTest(source, name))
  );
}

/** A named test, or a row of a table-driven `test(\`prefix ${row}\`)` whose label is in the file. */
function declaresTest(source: string, name: string) {
  if (source.includes(`test(${JSON.stringify(name)}`)) return true;
  for (const [, prefix, suffix] of source.matchAll(/test\(`([^`$]*)\$\{\w+\}([^`$]*)`/g)) {
    if (!name.startsWith(prefix!) || !name.endsWith(suffix!)) continue;
    const row = name.slice(prefix!.length, name.length - suffix!.length);
    if (row && source.includes(JSON.stringify(row))) return true;
  }
  return false;
}

const proofPath = (root: string, proof: string) => join(root, proof.split("#")[0]!);
