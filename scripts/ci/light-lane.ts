import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { boxSettings, type BoxInput } from "./box-router.ts";

// The light lane: the Check's seconds-long jobs run on the box's always-online light runners, named
// by BASALT_CI_LIGHT_LABEL, on the same first attempts box routing takes; everything else, and
// every job while the variable is empty, runs hosted. A job queued for the light runners can't move
// to hosted runners, so light-rescue.yml re-runs a Check whose light job a down box holds; the
// re-run is attempt 2, which these jobs' runs-on sends hosted.

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
  // Box routing's own rule for events, refs, attempts, forks and labels; the slot count is box
  // routing's alone, so it is fixed here.
  const settings = boxSettings({ ...input, slots: "1", label: input.label ?? "" });
  return typeof settings === "string" ? "" : settings.label;
}

/**
 * select's runs-on. select can't read its own output, so it repeats lightLabel's event, ref,
 * attempt and fork rule over the variable itself; the later light jobs read select's output.
 */
export const selectRunsOn =
  "${{ github.run_attempt == 1 && vars.BASALT_CI_LIGHT_LABEL != '' && " +
  "((github.event_name == 'push' && (github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/heads/batch/'))) || " +
  "(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)) && " +
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
