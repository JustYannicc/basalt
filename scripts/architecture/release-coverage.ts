import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { knownUncovered } from "../release-barrier/release-coverage/debt.ts";
import { preflightCoverage } from "../release-barrier/release-coverage/preflight.ts";
import { regressionCoverage } from "../release-barrier/release-coverage/regressions.ts";
import { rehearsalCoverage } from "../release-barrier/release-coverage/rehearsal.ts";
import { barrierRefusalCodes } from "./release-refusals.ts";
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
  const steps = releaseSteps(barrierRefusalCodes(root));
  const known = new Set(steps);
  const all: readonly Coverage[] = [
    ...regressionCoverage,
    ...preflightCoverage,
    ...rehearsalCoverage,
  ];
  const covered = new Set(all.map((entry) => entry.step));
  const debt = new Set<ReleaseStepId>(knownUncovered);
  const files = new Map<string, string | undefined>();
  const read = (path: string) => {
    if (!files.has(path))
      files.set(path, existsSync(path) ? readFileSync(path, "utf8") : undefined);
    return files.get(path);
  };
  return {
    steps,
    uncovered: steps.filter((step) => !covered.has(step) && !debt.has(step)),
    // A debt entry that is now covered, or no longer a step, must leave the list.
    settledDebt: knownUncovered.filter((step) => covered.has(step) || !known.has(step)),
    unknownSteps: all.filter((entry) => !known.has(entry.step)).map((entry) => entry.step),
    // A regression entry names the test that proves it; the test must exist and say what it guards.
    missingProofs: regressionCoverage
      .filter((entry) => !proofExists(read, root, entry.proof))
      .map((entry) => `${entry.step} -> ${entry.proof}`),
    // r6 shipped because the phase test swapped the whole release client for a stand-in, so the
    // real health() and witness readback never ran. A phase or command proven that way is untested.
    bypassedClient: regressionCoverage
      .filter(
        (entry) => /^(?:phase|command):/.test(entry.step) && proofExists(read, root, entry.proof),
      )
      .filter((entry) => !throughReleaseClient(read, root, entry))
      .map((entry) => `${entry.step} -> ${entry.proof}`),
  };
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

/** The proof's file carries a `// Regression:` marker and still declares the named test. */
function proofExists(read: Read, root: string, proof: string) {
  const [, name] = proof.split("#");
  const source = read(proofPath(root, proof));
  return (
    source !== undefined &&
    /\/\/ Regression: /.test(source) &&
    (name === undefined || source.includes(`test(${JSON.stringify(name)}`))
  );
}

const proofPath = (root: string, proof: string) => join(root, proof.split("#")[0]!);
