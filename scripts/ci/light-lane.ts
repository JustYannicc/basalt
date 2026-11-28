import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boxSettings, type BoxInput } from "./box-router.ts";

// The light lane: the seconds-long jobs of main's own Check run on the box's always-online light
// runners, named by BASALT_CI_LIGHT_LABEL, on the first attempt of a push to main, and so does the
// aggregate of a batch push's; every other Check, and every job while the variable is empty or
// names no light label, runs hosted. The aggregate is created last and waited behind other Checks'
// jobs for a hosted runner (#2118, and 12 minutes for a batch's); the light runners don't count
// toward the account's hosted limit. A job queued for the light runners can't move to hosted
// runners, so light-rescue.yml cancels the Check when its light job has waited 3 minutes, and
// box-rerun.yml re-runs it once it ends, as it does when only a light job failed or timed out; the
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

// Pushes only: their light jobs, seconds long and a few an hour, never wait minutes behind each
// other, so one that waits 3 minutes means the lane isn't taking jobs, which light-rescue.yml can
// act on without reading the box.
function pushLabel(input: LightInput, refs: (ref: string) => boolean) {
  const label = usableLightLabel(input.label);
  if (!label || input.event !== "push" || !refs(input.ref)) return "";
  // Box routing's own rule for attempts and labels; the slot count is box routing's alone, so it
  // is fixed here.
  const settings = boxSettings({ ...input, slots: "1", label });
  return typeof settings === "string" ? "" : settings.label;
}

/**
 * The light runners' label for select, long-started and cpa-pipeline, or "" when they run hosted.
 * Main's only: a batch creates them in its first wave, ahead of the hosted queue its own jobs fill;
 * only its aggregate, created last, waits behind that queue.
 */
export const lightLabel = (input: LightInput) =>
  pushLabel(input, (ref) => ref === "refs/heads/main");

/** The light runners' label for the aggregate, which main's and a batch's push both wait on. */
export const checkLabel = (input: LightInput) =>
  pushLabel(input, (ref) => ref === "refs/heads/main" || ref.startsWith("refs/heads/batch/"));

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

/** Whether the aggregate takes the light runners, by the runs-on and timeout expressions alike. */
const checkOnLight =
  "github.run_attempt == 1 && !contains(needs.*.result, 'cancelled') && needs.select.outputs.check_label";

/**
 * The aggregate's runs-on. It runs on always(), so after a cancel it still starts; once a need was
 * cancelled it runs hosted, or a down box would hold it and the cancelled run would never end.
 */
export const checkRunsOn = `\${{ ${checkOnLight} || 'ubuntu-latest' }}`;

/**
 * The aggregate's timeout-minutes. Main's are 25: its steps may take 17 minutes on a full Check.
 * A batch's on a light runner are 3, so a hung runner costs the batch minutes: main's aggregate
 * took 30 s there, a batch's 11 s hosted. Past it the run ends cancelled, and box-rerun.yml re-runs
 * it hosted (lightHung in box-rerun.ts).
 */
export const checkMinutes = { main: 25, batch: 3 };
export const checkTimeout =
  `\${{ ${checkOnLight} && startsWith(github.ref, 'refs/heads/batch/') && ` +
  `${checkMinutes.batch} || ${checkMinutes.main} }}`;

// select's own step, on every path including a reused Check's: it needs no token, only the event.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const input: LightInput = {
    event: env.GITHUB_EVENT_NAME ?? "",
    ref: env.GITHUB_REF ?? "",
    attempt: env.GITHUB_RUN_ATTEMPT,
    repository: env.GITHUB_REPOSITORY,
    headRepository: env.HEAD_REPOSITORY,
    label: env.LIGHT_LABEL,
  };
  const label = lightLabel(input);
  const check = checkLabel(input);
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `light_label=${label}\ncheck_label=${check}\n`);
  console.log(
    label
      ? `Light lane: long-started, cpa-pipeline and check run on ${label}.`
      : check
        ? `Light lane: check runs on ${check}.`
        : "Light lane: every job runs hosted.",
  );
}
