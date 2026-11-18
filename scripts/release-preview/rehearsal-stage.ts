import { fileURLToPath } from "node:url";

export const rehearsalScenarios = ["straight", "drain-resume", "single-writer"] as const;
export type RehearsalScenario = (typeof rehearsalScenarios)[number];

export function rehearsalScenario(value: string | undefined): RehearsalScenario {
  const scenario = rehearsalScenarios.find((name) => name === value);
  if (!scenario) throw new Error("Unknown release rehearsal scenario");
  return scenario;
}

/**
 * One stage per run, attempt and scenario. Parallel scenarios never share a stack or keys, and a
 * rerun never deploys a stage the previous attempt's cleanup may still be destroying.
 */
export function rehearsalNumber(
  runNumber: string | undefined,
  attempt: string | undefined,
  scenario: RehearsalScenario,
): number {
  if (!runNumber || !/^[1-9][0-9]{0,6}$/u.test(runNumber))
    throw new Error("A GitHub run number is required");
  if (!attempt || !/^[1-9]$/u.test(attempt)) throw new Error("A run attempt from 1 to 9 is required");
  return Number(runNumber) * 100 + Number(attempt) * 10 + rehearsalScenarios.indexOf(scenario) + 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const number = rehearsalNumber(process.argv[2], process.argv[3], rehearsalScenario(process.argv[4]));
  process.stdout.write(`subject=rehearsal-${number}\nnumber=${number}\n`);
}
