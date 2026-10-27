// Judges Basalt's own changed files. A file is clear only when it is on the reviewed list of paths
// no deployment reads, or a precise rule shows it changes neither the database nor a Workflow.
// Anything else is unknown for both, so a file nobody reviewed cannot ship a change unseen.
import type { Evidence } from "./types.ts";
import type { CarryImpact } from "./classify-patches.ts";
import { workflowRules } from "./carry-rules.ts";
import { changedIndices } from "./patch-diff.ts";
import { isDatabasePath, isWorkflowPath } from "./paths.ts";
import { stackImpact } from "./stack-impact.ts";

export const stackFile = "alchemy.run.ts";

/**
 * Reviewed paths that no production deployment reads or runs, each with the reason. Deploy
 * workflows, deploy-time scripts, every module a deploy entry point imports (the release gate and
 * deploy-safety included), workflows holding production deploy secrets, and the stack are
 * deliberately absent: they are always judged. `classify-local.test.ts` walks the imports of every
 * deploy entry point and fails if any module it reaches is on this list.
 */
export const nonDeployPaths: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:README|AGENTS|CLAUDE)\.md$|^\.gitignore$|^\.github\/pull_request_template\.md$|^scripts\/[\w/-]*README\.md$/,
    "repository documentation and settings"],
  [/^docs\//, "documentation"],
  [/^architecture\//, "the architecture model, generated and checked in CI"],
  [/^\.github\/workflows\/(?:app-lint|ci|release-merge|releases)\.yml$/,
    "CI, lint and release-PR workflows, which hold no production deploy secret and deploy nothing"],
  [/\.test\.[cm]?[jt]sx?$|\.test-helpers\.ts$/, "tests and their fixtures, run only in CI"],
  [/^scripts\/(?:app-lint|atlassian-tests|build-tests|connectors-tests|pool-tests|slack-tests|upstream-tests|deploy-main)\//,
    "test and lint suites, run only in CI"],
  [/^scripts\/(?:typecheck|check-atlassian|check-connectors|check-slack|connectors-source|pool-providers)\.ts$/,
    "CI checks and the release updater's provider check"],
  [/^scripts\/workerd-workflows\.d\.ts$/, "type declarations, which emit no code"],
  [/^scripts\/architecture\//, "architecture model generation, run in CI"],
  [/^scripts\/release-merge\/(?:check-receipt|classification|gate|validate-candidate)\.ts$/,
    "the release-PR merge gate's own steps, which run in its own workflow without deploy secrets"],
  [/^scripts\/releases\/(?:update|reconcile|run|metadata|simulate|simulation-fixtures|patches|git)\.ts$/,
    "the release updater that opens update PRs; the classifier modules a deploy imports are judged"],
  [/^scripts\/releases\/receipts\/[\w-]+\.json$/,
    "update receipts recording which pin an update PR targets; the pins themselves are classified"],
  [/^scripts\/(?:cutover\/|import-pool-accounts\.ts$)/, "one-off operator tools that no deploy runs"],
  [/^public\//, "static assets the Router serves; they name no database or Workflow"],
];

/**
 * Deployed runtime files reviewed as unable to change the database or a Workflow, with the reason.
 * They are data, not code, and name neither.
 */
export const benignRuntimeFiles: ReadonlyArray<readonly [RegExp, string]> = [
  [/^src\/pool\/providers\.json$/,
    "the pool's provider id and display-name table, generated from the pinned node release"],
];

/** Basalt files that set the stage and the brand, which every deployed resource name derives from. */
const identityPath = /^(?:brand\.ts|scripts\/environment\.ts)$/;
/** Files classified by their own evidence: carried patches, their registry and the pinned sources. */
const separatelyClassified = /^patches\/[^/]+\.patch$|^scripts\/releases\/patches\.json$|^upstream\.json$|^containers\/pool\/releases\.json$/;
/** Basalt's runtime: Worker, pool app and container sources. */
const runtimeRoot = /^(?:src|apps\/pool|containers\/pool)\//;
/**
 * Runtime modules a deploy entry point imports: they declare resources, bindings, container classes
 * or deploy settings. `classify-local.test.ts` checks every runtime module a deploy reaches is here
 * or a reviewed helper.
 */
export const deployModule = /^src\/(?:pool\/(?:deployment|database|database-settings|token)|telemetry\/deployment|catalog\/settings|catalog\/zendesk\/metadata)\.ts$|^src\/.*\/deployment\.ts$/;

/** Changed Basalt files whose contents the local rules read. */
export const judgedByContent = (path: string) => path === stackFile || runtimeRoot.test(path);

const unjudged = "changed without its contents to judge";

export type LocalContents = Record<string, { base: string; candidate: string }>;

type Source = Evidence["sources"][number];

/** Database and Workflow evidence for Basalt's own changed files. */
export function localEvidence(
  base: string,
  candidate: string,
  paths: string[],
  contents: LocalContents = {},
): { database: Source[]; workflow: Source[] } {
  type Entry = { name: string; reason: string; state: Source["state"]; paths: string[] };
  const database = new Map<string, Entry>();
  const workflow = new Map<string, Entry>();
  const note = (area: typeof database, reason: string, state: Source["state"], path: string) => {
    const name = path === stackFile ? "Basalt stack" : "Basalt source";
    const key = `${name}\0${state}\0${reason}`;
    const entry = area.get(key) ?? { name, reason, state, paths: [] };
    entry.paths.push(path);
    area.set(key, entry);
  };
  const both = (reason: string, state: Source["state"], path: string) => {
    note(database, reason, state, path);
    note(workflow, reason, state, path);
  };

  for (const path of paths) {
    if (separatelyClassified.test(path) || [...nonDeployPaths, ...benignRuntimeFiles].some(([rule]) => rule.test(path))) continue;
    if (identityPath.test(path)) {
      both("sets the stage and every physical name", "changed", path);
      continue;
    }
    const content = contents[path];
    if (path === stackFile) {
      const impact = content ? stackImpact(content.base, content.candidate) : unsupplied;
      for (const [area, { state, detail }] of [[database, impact.database], [workflow, impact.workflow]] as const)
        if (state !== "unchanged") note(area, `${stackFile} ${detail}`, state, path);
      continue;
    }
    if (runtimeRoot.test(path)) {
      if (isDatabasePath(path)) note(database, "names database code", "changed", path);
      else note(database, "runtime source changed without a database compatibility proof", "unknown", path);
      if (isWorkflowPath(path)) note(workflow, "names a Workflow", "changed", path);
      else if (deployModule.test(path)) note(workflow, "declares resources or settings the deploy reads", "unknown", path);
      else if (!content) note(workflow, unjudged, "unknown", path);
      else if (changedLines(content).some(workflowRules.isCode)) note(workflow, "changes Workflow code", "changed", path);
      continue;
    }
    both("is not on the reviewed list of paths no deployment reads", "unknown", path);
  }

  const sources = (area: typeof database): Source[] => [...area.values()].map(({ name, reason, state, paths: changed }) => ({
    name,
    state,
    base,
    candidate,
    changedPaths: changed.sort(),
    reason,
  }));
  return { database: sources(database), workflow: sources(workflow) };
}

const unsupplied: { database: CarryImpact; workflow: CarryImpact } = {
  database: { state: "unknown", detail: unjudged },
  workflow: { state: "unknown", detail: unjudged },
};

function changedLines({ base, candidate }: { base: string; candidate: string }): string[] {
  const sides = [base.split("\n"), candidate.split("\n")];
  return changedIndices(sides[0]!, sides[1]!).flatMap((changed, side) => [...changed].map((index) => sides[side]![index]!));
}
