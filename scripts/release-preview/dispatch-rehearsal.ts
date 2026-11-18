import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { provenTeardown } from "./rehearsal-cleanup.ts";
import { subscriptionSmokeInputs } from "./credentials.ts";
import { parseSubjectArgument } from "../preview/subject.ts";

const run = (command: string, args: string[], cwd?: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const labels = {
  forward: "release-rehearsal-single-writer",
  recovery: "release-rehearsal-single-writer-step4",
  native: "release-rehearsal-native",
} as const;
const infraOnlyLabel = "release-rehearsal-infra-only";

/**
 * Every repository secret and variable the rehearsal workflow reads, less the subscription inputs
 * an infra-only run never uses. A paid run must not start only to fail on a missing input.
 */
export function rehearsalInputs(workflow: string, infraOnly: boolean) {
  const skipped: readonly string[] = infraOnly ? subscriptionSmokeInputs : [];
  const found = { secrets: new Set<string>(), vars: new Set<string>() };
  for (const [, kind, name] of workflow.matchAll(/\$\{\{\s*(secrets|vars)\.([A-Z0-9_]+)\s*\}\}/gu))
    if (!skipped.includes(name!)) found[kind as "secrets" | "vars"].add(name!);
  return { secrets: [...found.secrets].sort(), vars: [...found.vars].sort() };
}

export function missingInputs(
  required: ReturnType<typeof rehearsalInputs>,
  present: { secrets: string[]; vars: string[] },
) {
  return [
    ...required.secrets
      .filter((name) => !present.secrets.includes(name))
      .map((name) => `secret ${name}`),
    ...required.vars
      .filter((name) => !present.vars.includes(name))
      .map((name) => `variable ${name}`),
  ];
}

function requireRehearsalInputs(root: string, infraOnly: boolean) {
  const workflow = readFileSync(
    join(root, ".github", "workflows", "release-rehearsal.yml"),
    "utf8",
  );
  const names = (kind: "secret" | "variable") =>
    (JSON.parse(run("gh", [kind, "list", "--json", "name"], root)) as { name: string }[]).map(
      (item) => item.name,
    );
  const missing = missingInputs(rehearsalInputs(workflow, infraOnly), {
    secrets: names("secret"),
    vars: names("variable"),
  });
  if (missing.length)
    throw new Error(`The rehearsal would fail on missing inputs: ${missing.join(", ")}`);
}

/**
 * Starts one paid single-change rehearsal: this branch with the change's exact commit merged on
 * top, as its own pull request carrying the rehearsal label. Nothing is deployed until that
 * label's run starts. `dryRun` merges in a scratch checkout and reports, without pushing.
 */
export function dispatchSingleWriter(
  root: string,
  change: string,
  options: {
    base?: string;
    dryRun?: boolean;
    recovery?: boolean;
    native?: boolean;
    infraOnly?: boolean;
  } = {},
) {
  const scenario = options.native ? "native" : options.recovery ? "recovery" : "forward";
  const label = labels[scenario];
  if (!/^[a-f0-9]{40}$/u.test(change))
    throw new Error("Name the change by its exact 40-character head commit");
  const base = options.base ?? "origin/feat/release-rehearsal";
  if (!options.dryRun) run("git", ["fetch", "-q", "origin", "feat/release-rehearsal"], root);
  run("git", ["fetch", "-q", "origin", change], root);
  const scratch = mkdtempSync(join(tmpdir(), "rehearsal-dispatch-"));
  try {
    run("git", ["worktree", "add", "-q", "--detach", scratch, base], root);
    const onto = run("git", ["rev-parse", "HEAD"], scratch);
    try {
      run(
        "git",
        [
          "-c",
          "user.name=Release rehearsal",
          "-c",
          "user.email=release-rehearsal@users.noreply.github.com",
          "merge",
          "-q",
          "--no-ff",
          "--no-edit",
          change,
        ],
        scratch,
      );
    } catch {
      const conflicts = run("git", ["diff", "--name-only", "--diff-filter=U"], scratch)
        .split("\n")
        .filter(Boolean);
      run("git", ["merge", "--abort"], scratch);
      throw new Error(
        `The change does not merge onto the rehearsal cleanly: ${conflicts.join(", ")}`,
      );
    }
    const head = run("git", ["rev-parse", "HEAD"], scratch);
    // The run reads the candidate's own workflow, so its inputs are checked from the merge.
    requireRehearsalInputs(scratch, options.infraOnly === true);
    if (
      run("git", ["rev-parse", "HEAD^1"], scratch) !== onto ||
      run("git", ["rev-parse", "HEAD^2"], scratch) !== change
    )
      throw new Error("The rehearsal candidate is not the rehearsal branch plus the change");
    // The scenario is in the name: two dispatches of one change in the same second share a merge commit.
    const branch = `rehearse/${scenario === "recovery" ? "step4" : scenario}${options.infraOnly ? "-infra" : ""}-${head.slice(0, 12)}`;
    if (options.dryRun)
      return {
        dryRun: true,
        onto,
        change,
        head,
        branch,
        changed: run("git", ["diff", "--name-only", "HEAD^1", "HEAD"], scratch).split("\n").length,
      };
    run("git", ["push", "-q", "origin", `HEAD:refs/heads/${branch}`], scratch);
    const body = join(scratch, ".rehearsal-body.md");
    writeFileSync(
      body,
      `Rehearsal only, never merge: \`${change}\` on the release rehearsal at \`${onto}\`.\n`,
    );
    // Only a rehearsal vehicle: it never joins a batch, so nothing merges it, and verify closes it.
    const url = run("gh", [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      `DO NOT MERGE — rehearsal ${change}`,
      "--body-file",
      body,
      "--label",
      label,
      ...(options.infraOnly ? ["--label", infraOnlyLabel] : []),
    ]);
    return { dryRun: false, onto, change, head, branch, url };
  } finally {
    run("git", ["worktree", "remove", "--force", scratch], root);
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Teardown is proven from the run's own evidence: each stage's receipt says the rehearsal destroyed
 * the stage and verified its resources, State rows and outputs are absent.
 */
export function verifyTeardown(repository: string, pullRequest: number) {
  const head = run("gh", [
    "pr",
    "view",
    String(pullRequest),
    "--repo",
    repository,
    "--json",
    "headRefOid",
    "-q",
    ".headRefOid",
  ]);
  const runs = JSON.parse(
    run("gh", [
      "api",
      `repos/${repository}/actions/workflows/release-rehearsal.yml/runs?head_sha=${head}&per_page=20`,
    ]),
  ).workflow_runs as Array<{ id: number; status: string; conclusion: string | null }>;
  const latest = runs.find((item) => item.status === "completed");
  if (!latest) throw new Error("No completed rehearsal run for this pull request's head");
  const { artifacts } = JSON.parse(
    run("gh", ["api", `repos/${repository}/actions/runs/${latest.id}/artifacts?per_page=100`]),
  ) as { artifacts: Array<{ id: number; name: string }> };
  const checkpoints = artifacts.flatMap(
    (item) => /^release-rehearsal-cleanup-(rehearsal-[0-9]+)-/u.exec(item.name)?.[1] ?? [],
  );
  if (!checkpoints.length) return { run: latest.id, stages: [], proven: "nothing was deployed" };
  const scratch = mkdtempSync(join(tmpdir(), "rehearsal-verify-"));
  try {
    const unproven = checkpoints.filter((slug) => {
      const receipt = artifacts.find((item) => item.name === `release-rehearsal-${slug}`);
      if (!receipt) return true;
      const zip = join(scratch, `${slug}.zip`);
      writeFileSync(
        zip,
        execFileSync("gh", ["api", `repos/${repository}/actions/artifacts/${receipt.id}/zip`]),
      );
      try {
        return !provenTeardown(
          JSON.parse(run("unzip", ["-p", zip, "rehearsal-receipt.json"])),
          parseSubjectArgument(slug),
        );
      } catch {
        return true;
      }
    });
    if (!unproven.length) {
      // Proven teardown retires the rehearsal vehicle: its pull request and branch exist only for the run.
      run("gh", ["pr", "close", String(pullRequest), "--repo", repository, "--delete-branch"]);
      return {
        run: latest.id,
        stages: checkpoints,
        proven: "each stage's receipt verified its teardown; pull request closed",
      };
    }
    // An unsuccessful run's stages are destroyed by release-cleanup; its verify step is the proof.
    throw new Error(
      `Teardown is not proven by run ${latest.id} for ${unproven.join(", ")}: confirm its release-cleanup run destroyed and verified them`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, value] = process.argv.slice(2);
  const repository = process.env.GITHUB_REPOSITORY ?? "JustYannicc/basalt";
  if (mode === "dispatch" && value)
    console.log(
      JSON.stringify(
        dispatchSingleWriter(process.cwd(), value, {
          dryRun: process.argv.includes("--dry-run"),
          recovery: process.argv.includes("--step4"),
          native: process.argv.includes("--native"),
          infraOnly: process.argv.includes("--infra-only"),
          base: process.argv.includes("--local") ? "HEAD" : undefined,
        }),
      ),
    );
  else if (mode === "verify" && /^[1-9][0-9]*$/u.test(value ?? ""))
    console.log(JSON.stringify(verifyTeardown(repository, Number(value))));
  else
    throw new Error(
      "Usage: dispatch-rehearsal.ts dispatch <change-head-sha> [--step4|--native] [--infra-only] [--dry-run] [--local] | verify <pull-request>",
    );
}
