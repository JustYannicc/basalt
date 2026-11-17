import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { releaseCoverageGaps } from "./release-coverage.ts";

// Uncovered release steps when the gate landed.
const DEBT_CEILING = 586;
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

test("every release step is proven by a regression scenario, the preflight or the rehearsal", () => {
  const gaps = releaseCoverageGaps(root);
  // The enumeration itself must keep finding the release: an empty list would pass vacuously.
  expect(gaps.steps.filter((step) => step.startsWith("command:")).length).toBeGreaterThan(25);
  expect(gaps.steps.filter((step) => step.startsWith("operation:")).length).toBeGreaterThan(20);
  expect(gaps.steps.filter((step) => step.startsWith("phase:")).length).toBeGreaterThan(4);
  expect(gaps.steps.filter((step) => step.startsWith("refusal:")).length).toBeGreaterThan(400);
  expect
    .soft(gaps.uncovered, "release steps with no regression, preflight or rehearsal proof")
    .toEqual([]);
  expect.soft(gaps.unknownSteps, "coverage entries naming steps that no longer exist").toEqual([]);
  expect.soft(gaps.missingProofs, "regression entries without their test file").toEqual([]);
  expect
    .soft(gaps.bypassedClient, "phase or command proofs that stand in for the release client")
    .toEqual([]);
  // The debt only shrinks: raising this number is a visible decision to merge an untested step.
  expect(gaps.debt, "knownUncovered grew").toBeLessThanOrEqual(DEBT_CEILING);
  expect
    .soft(gaps.settledDebt, "covered or removed steps to delete from knownUncovered")
    .toEqual([]);
  // The refusal scan parses every release source; a loaded runner needs more than the default.
}, 60_000);
