import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boxSettings, type BoxInput } from "./box-router.ts";

// The light lane: the seconds-long jobs of main's own Check run on the box's always-online light
// runners, named by BASALT_CI_LIGHT_LABEL, on the first attempt of a push to main only; every other
// Check, and every job while the variable is empty or names no light label, runs hosted. Main's
// summary job is created last and waited behind batch jobs for a hosted runner (#2118); the light
// runners don't count toward the account's hosted limit. A job queued for the light runners can't
// move to hosted runners, so light-rescue.yml cancels main's Check when its light job has waited 3
// minutes, and box-rerun.yml re-runs it once it ends, as it does when only a light job failed; the
// re-run is attempt 2, which these jobs' runs-on sends hosted.

/**
 * How a light runner label ends. No label other runners share ends so, which select's runs-on can
 * check without naming them: a broad label would hand pull request code to the release runners.
 */
export const lightSuffix = "-light";

/** The variable as the light runners' label, or "" when it is no plain label ending in the suffix. */
export function usableLightLabel(value: string | undefined) {
  const label = value ?? "";
  return /^[\w.-]+$/.test(label) && label.toLowerCase().endsWith(lightSuffix) ? label : "";
}

/**
 * The label select's runs-on takes from the variable, by the part of the rule an expression can
 * check; wider than usableLightLabel, so the rescue watches every label select may wait on.
 */
export function selectLightLabel(value: string | undefined) {
  const label = value ?? "";
  return label.toLowerCase().endsWith(lightSuffix) && !/[ ,]/.test(label) ? label : "";
}

/** How long a light job may wait queued before the light runners count as not taking it. */
export const queuedMinutes = 3;

/** Whether a job's labels send it to light runners: any label with the suffix does. */
export const onLightRunners = (labels: readonly unknown[] | undefined) =>
  (labels ?? []).some((label) => String(label).toLowerCase().endsWith(lightSuffix));

/** The jobs the light lane runs. box-watch is not one: it cancels the Check when the box is down. */
export const lightJobs = ["select", "long-started", "cpa-pipeline", "check"];

export type LightInput = Pick<
  BoxInput,
  "event" | "ref" | "attempt" | "repository" | "headRepository"
> & {
  /** BASALT_CI_LIGHT_LABEL. */
  label?: string;
};

/** The light runners' label for this Check, or "" when its light jobs run hosted. */
export function lightLabel(input: LightInput) {
  const label = usableLightLabel(input.label);
  // Main's push Checks only: with main the lane's only user, a light job that waits 3 minutes means
  // the lane isn't taking jobs, which light-rescue.yml can act on without reading the box.
  if (!label || input.event !== "push" || input.ref !== "refs/heads/main") return "";
  // Box routing's own rule for attempts and labels; the slot count is box routing's alone, so it
  // is fixed here.
  const settings = boxSettings({ ...input, slots: "1", label });
  return typeof settings === "string" ? "" : settings.label;
}

/**
 * select's runs-on. select can't read its own output, so it repeats lightLabel's event, ref and
 * attempt rule over the variable itself, and as much of its label rule as an expression can: the
 * suffix, and no space or comma. The later light jobs read select's output.
 */
export const selectRunsOn =
  `\${{ github.run_attempt == 1 && endsWith(vars.BASALT_CI_LIGHT_LABEL, '${lightSuffix}') && ` +
  "!contains(vars.BASALT_CI_LIGHT_LABEL, ' ') && !contains(vars.BASALT_CI_LIGHT_LABEL, ',') && " +
  "github.event_name == 'push' && github.ref == 'refs/heads/main' && " +
  "vars.BASALT_CI_LIGHT_LABEL || 'ubuntu-latest' }}";

/** long-started's and cpa-pipeline's runs-on. A re-run reuses attempt 1's outputs, so it runs hosted. */
export const laterRunsOn =
  "${{ github.run_attempt == 1 && needs.select.outputs.light_label || 'ubuntu-latest' }}";

/**
 * The aggregate's runs-on. It runs on always(), so after a cancel it still starts; once a need was
 * cancelled it runs hosted, or a down box would hold it and the cancelled run would never end.
 */
export const checkRunsOn =
  "${{ github.run_attempt == 1 && !contains(needs.*.result, 'cancelled') && needs.select.outputs.light_label || 'ubuntu-latest' }}";

// select's own step, on every path including a reused Check's: it needs no token, only the event.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const label = lightLabel({
    event: env.GITHUB_EVENT_NAME ?? "",
    ref: env.GITHUB_REF ?? "",
    attempt: env.GITHUB_RUN_ATTEMPT,
    repository: env.GITHUB_REPOSITORY,
    headRepository: env.HEAD_REPOSITORY,
    label: env.LIGHT_LABEL,
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `light_label=${label}\n`);
  console.log(
    label
      ? `Light lane: long-started, cpa-pipeline and check run on ${label}.`
      : "Light lane: every job runs hosted.",
  );
}
