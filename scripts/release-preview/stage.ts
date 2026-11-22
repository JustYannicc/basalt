/**
 * One mode against a standing rehearsal stage, so an attempt replays only what it tests:
 *
 *   check     setup and credentials only; touches nothing
 *   baseline  deploy the stage the way production is today (fleet classes absent)
 *   plan      R0: the cutover's plan, `--include PoolWorker` with the fleet declared; applies nothing
 *   apply     R1: the same deploy applied, read back, then planned again (must be all noop)
 *   destroy   tear the stage down and prove it gone
 *
 * Every apply and destroy goes through the release entry (`scripts/release/deploy.ts`), which never
 * lets Alchemy bootstrap the shared State store; nothing here runs the CLI with `--yes`.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { previewStageOrigin, stageEnvironment } from "../environment.ts";
import { stageModelRequest } from "./stage-model.ts";
import { stateEvidence } from "./stage-rows.ts";
import { previewPoolDatabaseBranch } from "../../src/pool/database-settings.ts";
import {
  deployStage,
  destroyStage,
  planStage,
  redeployStage,
  verifyStageAbsent,
  withStageBuild,
} from "../preview/lifecycle.ts";
import { parseSubjectArgument, stageNames, type StageSubject } from "../preview/subject.ts";
import { describeError, redactor } from "./redact.ts";
import { alchemyPreviewStateReader } from "../preview/inventory.ts";
import { summarize, type Sample } from "./stage-probe.ts";
import { manifestPath } from "./checkpoint.ts";
import { sealManifest } from "./manifest.ts";
import { nativeHooks } from "./rehearsal-native-hooks.ts";
import { composeRootPin } from "./stage-pin.ts";
import { adoptWithoutSeed, seedAndAdopt } from "./stage-seed.ts";
import { diagnoseStagePool, stageWorker, workerScripts } from "./stage-diagnose.ts";
import { poolWorkerVersionsBetween } from "./stage-versions.ts";
import { readSecretsStores } from "./stage-secrets.ts";
import {
  planHighlights,
  requireBaselineShape,
  requireCutoverShape,
  type NativeReadBack,
} from "./rehearsal-native.ts";

export const stageModes = [
  "check",
  "baseline",
  "plan",
  "apply",
  "code",
  "settle",
  "fault",
  "heal",
  "release",
  "classplan",
  "adopt",
  "diagnose",
  "secrets",
  "destroy",
] as const;
export type StageMode = (typeof stageModes)[number];

/** The pull-request label that dispatches a mode: `stage-<mode>` on lane 1, `stage-<mode>-<lane>` on 2 or 3. */
export function stageLabel(label: string): { mode: StageMode; lane: number } | undefined {
  const match = /^stage-([a-z]+)(?:-([1-6]))?$/u.exec(label);
  const mode = stageModes.find((name) => name === match?.[1]);
  return mode ? { mode, lane: Number(match?.[2] ?? "1") } : undefined;
}

/** A lane's stage stands across runs; its keys derive from the state key, so every job re-plans it. */
export const laneSubject = (lane: number): StageSubject => {
  if (![1, 2, 3, 4, 5, 6].includes(lane)) throw new Error("A standing stage lane is 1 to 6");
  return parseSubjectArgument(`rehearsal-${lane}`);
};

/** The fleet declaration each mode deploys: production's today, or the cutover's. */
export const declaration = {
  baseline: { POOL_FLEET_CLASSES: "absent" },
  cutover: { POOL_FLEET_CLASSES: "declared", POOL_FLEET_BUILD: "true" },
} as const;

const root = fileURLToPath(new URL("../../", import.meta.url));
const cloud = join(root, ".upstream/apps/hosted/cloud");

/**
 * The stage env names the harness tree's built app framework and its upstream pin. A candidate
 * tree releases what it built itself (`withStageBuild(candidate)`), so its own framework is the
 * one uploaded; a candidate on another upstream pin would carry a build version it did not build.
 */
export function candidateTreeEnvironment(harness: string, tree: string): NodeJS.ProcessEnv {
  if (tree === harness) return {};
  const pin = (at: string) =>
    (JSON.parse(readFileSync(join(at, "upstream.json"), "utf8")) as { commit?: unknown }).commit;
  if (pin(tree) !== pin(harness))
    throw new Error("The candidate tree pins another upstream commit than the stage's harness");
  // The served framework version also comes from the harness tree (`framework-release.ts`).
  const served = (at: string) => readFileSync(join(at, "framework-release.ts"), "utf8");
  if (served(tree) !== served(harness))
    throw new Error("The candidate tree serves another framework version than the stage's harness");
  return { EXECUTOR_APPS_FRAMEWORK: join(tree, ".upstream/.local/basalt-framework") };
}

async function runEntry(
  command: "plan" | "deploy" | "serving" | "rollback" | "boot" | "accept",
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  outputs: string,
  {
    policy = "cutover-classes",
    args = [],
    include = "PoolWorker",
    tree = root,
  }: {
    policy?: string | null;
    args?: readonly string[];
    include?: string | null;
    /** Another prepared checkout whose own entry, policies and stack release onto the stage. */
    tree?: string;
  } = {},
) {
  const entry = join(tree, "scripts/release/deploy.ts");
  const cloud = join(tree, ".upstream/apps/hosted/cloud");
  if (!existsSync(entry))
    throw new Error("The release entry is not in this tree; nothing applies without it");
  const config = stageEnvironment(subject, source);
  const seed = join(outputs, `seed-${command}-${Date.now()}.json`);
  const log = join(outputs, `entry-${command}-${Date.now()}.log`);
  await rm(join(tree, ".local/release", `${command}.json`), { force: true });
  const code = await new Promise<number>((done) => {
    const child = spawn(
      "bun",
      [
        entry,
        command,
        "--stage",
        config.stage,
        "--config",
        "alchemy.run.ts",
        // The step's own allow-list, include and wire rules, exactly as production will run it.
        ...((command === "plan" || command === "deploy") && policy
          ? ["--policy", join(tree, `scripts/release/policies/${policy}.json`)]
          : []),
        // Without a policy, the cutover's include still scopes the plan to PoolWorker and its inputs.
        ...((command === "plan" || command === "deploy") && !policy && include
          ? ["--include", include]
          : []),
        ...args,
      ],
      {
        cwd: cloud,
        env: {
          PATH: source.PATH,
          HOME: source.HOME,
          ...config.deploy,
          ...config.seed,
          ...candidateTreeEnvironment(root, tree),
          ...extra,
          PREVIEW_AUTH_SEED_OUTPUT: seed,
          // The entry keeps its private failure detail here (release-failure.txt).
          BASALT_STAGE_OUTPUT_DIR: outputs,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const keep = (chunk: Buffer) => void appendFile(log, chunk, { mode: 0o600 });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("close", (status) => done(status ?? 1));
  });
  const redact = redactor(config.deploy, source);
  const text = await readFile(log, "utf8").catch(() => "");
  if (code !== 0) {
    // The entry's wire journal (`GET {host}/…`) ends its output; quoting its tail once read as a
    // failed request. The stop line and the refused rules lead, the rest of the tail follows.
    const lines = text
      .split(/\r?\n/u)
      .filter(
        (line) =>
          line.trim() &&
          !/^\s+at .*(?:\(|file:|node:|<anonymous>)/u.test(line) &&
          !/^(?:GET|HEAD|PUT|POST|PATCH|DELETE) \S+$/u.test(line),
      );
    const stop = lines.filter((line) => /^Release stopped|^- \[[a-z0-9-]+\] /u.test(line));
    throw new Error(
      `The release entry's ${command} failed with exit ${code}:\n${redact(
        [...stop, ...lines.slice(-150)].join("\n"),
      )}`,
    );
  }
  const record = (
    command === "plan" || command === "deploy"
      ? JSON.parse(await readFile(join(tree, ".local/release", `${command}.json`), "utf8"))
      : undefined
  ) as unknown;
  return { record, highlights: planHighlights(redact(text)) };
}

/**
 * Rehearsal-only diagnostic: the pool database budget script once by itself, for this lane's
 * database and pool branch, before the deploy. Its failure text goes to stdout, which the deploy's
 * report drops, so the whole output stays in the private directory. It never fails the mode.
 */
async function budgetProbe(subject: StageSubject, source: NodeJS.ProcessEnv, outputs: string) {
  const config = stageEnvironment(subject, source);
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    PLANETSCALE_ORGANIZATION: source.PLANETSCALE_ORGANIZATION,
    PLANETSCALE_API_TOKEN_ID: source.PLANETSCALE_API_TOKEN_ID,
    PLANETSCALE_API_TOKEN: source.PLANETSCALE_API_TOKEN,
    POOL_BUDGET_DATABASE: config.deploy.TEST_STAGE_DATABASE,
    POOL_BUDGET_BRANCH: previewPoolDatabaseBranch(config.stage),
    // The script refuses a target that is not this stage's own (patch 0693's ownPoolBudgetTarget).
    POOL_BUDGET_STAGE: config.stage,
  };
  const started = Date.now();
  const { code, output } = await new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn("node", ["scripts/database-pool-budget.ts"], {
      cwd: cloud,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += `[stdout] ${chunk.toString("utf8")}`));
    child.stderr.on("data", (chunk: Buffer) => (output += `[stderr] ${chunk.toString("utf8")}`));
    child.once("error", (error) =>
      done({ code: null, output: `${output}[spawn] ${error.message}\n` }),
    );
    child.once("close", (status) => done({ code: status, output }));
  });
  await writeFile(
    join(outputs, "budget-probe.txt"),
    `database=${env.POOL_BUDGET_DATABASE} branch=${env.POOL_BUDGET_BRANCH} exit=${code} ms=${Date.now() - started}\n${output}`,
    { mode: 0o600 },
  );
}

/** The probe runs as its own process; it is stopped by the PID captured at spawn, never by pattern. */
function startProbe(lane: number, out: string, source: NodeJS.ProcessEnv) {
  const child = spawn(
    "node",
    [join(root, "scripts/release-preview/stage-probe.ts"), String(lane), out],
    {
      cwd: root,
      env: source,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on(
    "data",
    (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-8192)),
  );
  const exited = new Promise<number | null>((done) => child.once("close", done));
  return {
    stop: async () => {
      child.kill("SIGTERM");
      const code = await Promise.race([
        exited,
        new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 30_000).unref()),
      ]);
      if (code === "timeout") child.kill("SIGKILL");
      // The bridge may print after the summary; the summary is the last line that parses as one.
      for (const line of stdout.trim().split("\n").toReversed()) {
        try {
          const value = JSON.parse(line) as { samples?: unknown };
          if (value && typeof value === "object" && "samples" in value) return value;
        } catch {
          // Not the summary line.
        }
      }
      // No summary line: summarize the samples the probe streamed to its file.
      const samples = (await readFile(out, "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Sample);
      return samples.length
        ? { ...summarize(samples), fromFile: true }
        : { unavailable: redactor(source)(stderr.split("\n").slice(-20).join("\n")) };
    },
  };
}

/**
 * The release a healing production pool needs, rehearsed: the stage is deployed with the
 * rehearsal-only fault command, the fault leaves the root running but refusing exactly as
 * production did, then a code-only release of the fix candidate (a branch without the fault
 * command) must plan zero changes on the root container application, and the Worker's own bounded
 * restart must replace the old instance before acceptance. The probe samples the whole time.
 */
// The heal candidate on the re-cut repair batch (batch/healing at 251c1d4a) plus the stage-only overlay. A new name
// per base: a candidate branch is never force-pushed.
export const healCandidateBranch = "rehearse/heal-candidate-251c1d4";

/**
 * The expect arguments the candidate's own release.yml gives a declared root restart: the policy's
 * bound as `--within` on the older form, the apply's outcome as `--apply` on the newer one.
 */
export function restartExpectArgs(input: {
  workflow: string;
  bound: number | undefined;
  serving: string;
  apply: "success" | "failure";
}) {
  const line = /expect=\(--expect restart[^)]*\)/u.exec(input.workflow)?.[0];
  if (!line) throw new Error("The candidate's release.yml declares no root restart acceptance");
  const args = ["--expect", "restart", "--serving", input.serving];
  if (line.includes("--apply")) args.push("--apply", input.apply);
  if (line.includes("--within")) {
    if (!input.bound) throw new Error("The candidate's policy declares no restart bound");
    args.push("--within", String(input.bound));
  }
  return args;
}

/** The release's own `accept` step after a heal's apply, recorded whole and never thrown. */
async function healAcceptance(input: {
  candidate: string;
  subject: StageSubject;
  source: NodeJS.ProcessEnv;
  env: NodeJS.ProcessEnv;
  outputs: string;
  servingFile: string;
  rootBootFile: string;
  apply: "success" | "failure";
}) {
  const out = join(input.outputs, "heal-acceptance.json");
  try {
    const policy = JSON.parse(
      await readFile(join(input.candidate, "scripts/release/policies/code-restart.json"), "utf8"),
    ) as { acceptance?: { rootRestart?: { bound?: unknown; withinSeconds?: unknown } } };
    const args = restartExpectArgs({
      workflow: await readFile(join(input.candidate, ".github/workflows/release.yml"), "utf8"),
      // The older policy states seconds; the newer names a constant, used with --apply, not --within.
      bound:
        typeof policy.acceptance?.rootRestart?.withinSeconds === "number"
          ? policy.acceptance.rootRestart.withinSeconds
          : typeof policy.acceptance?.rootRestart?.bound === "number"
            ? policy.acceptance.rootRestart.bound
            : undefined,
      serving: input.servingFile,
      apply: input.apply,
    });
    let refused: string | undefined;
    await runEntry("accept", input.subject, input.source, input.env, input.outputs, {
      args: [...args, "--root-boot", input.rootBootFile, "--out", out],
      tree: input.candidate,
    }).catch((error: unknown) => {
      refused = redactor(input.source)(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 2_000);
    });
    const record = await readFile(out, "utf8").then(
      (text) => JSON.parse(redactor(input.source)(text)) as unknown,
      () => null,
    );
    return { ran: true, args: args.filter((arg) => !arg.startsWith("/")), refused, record };
  } catch (error) {
    return { ran: false, why: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What a stage heal pass does and does not prove, kept with every heal run (pass or fail) so
 * nobody reads it as "serves model calls".
 */
const healReproduces = [
  "after the fault: production's shape (a restart authorization over the selected identity, no identity, a witness with a launch and no boot id)",
  "epoch 1 here against production's 4",
  "before the fault: an adoption record here against production's restart record",
  "the Worker that wrote the record is not the Worker that heals, as in production",
  "the infra half only: new boot selected at epoch + 1, recovery ready, active-health 200, inspect clean, the stop path; the 27 model calls need accounts and stay production's own acceptance",
  'a zero-policy stage does not prove: that a policy is installed on the new boot (none is); that the membership pass renews one (nothing to renew); or production\'s own case, a clean policy that expired long ago, where recovery reports ready only after the membership pass has renewed it. That case rests on the worker test "the stuck record heals by itself when its pool policy expired long ago"; a stage pass is no proof of that hold or of its timing',
];

/**
 * The controller allows three forced restarts and the container three forced stops an hour, and
 * the next one ends in a durable needs-a-person (`restart_limit`) that every later pass stops at.
 * A fault-family run therefore starts only with a stop left and no person already needed.
 */
async function requireRestartBudget(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  before: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  const recovery = before.recovery as {
    values?: Record<string, unknown>;
    restartsLastHour?: number | null;
  } | null;
  const values = recovery?.values ?? {};
  const needsPerson = Object.entries(values).find(
    ([key, value]) => /needs/iu.test(key) && value !== null && value !== undefined,
  );
  const stops = await workerLogLines(
    subject,
    source,
    Date.now() - 60 * 60_000,
    "POOL_RUNTIME_FORCED_STOP",
  );
  // The log can drop lines; the controller's own clock cannot. The larger count decides.
  const restarts = recovery?.restartsLastHour ?? 0;
  result.restartBudget = {
    forcedStopsLastHour: stops.length,
    controllerRestartsLastHour: recovery?.restartsLastHour ?? null,
    needsPerson: needsPerson?.[0] ?? null,
  };
  if (needsPerson)
    throw new Error(
      `The controller already needs a person (${needsPerson[0]}); no fault runs over it`,
    );
  if (Math.max(stops.length, restarts) >= 3)
    throw new Error(
      `The last hour holds ${stops.length} logged forced stops and ${restarts} controller restarts; the next would end in restart_limit`,
    );
}

/**
 * The stage-only overlay a heal candidate carries on top of the commit it heals with: every
 * first-parent commit back to the first that is not marked as overlay, and its files and lines.
 * Production never runs this code, so every record says how much of it there is.
 */
export function overlayExtent(candidate: string) {
  const commits = execFileSync("git", ["log", "--first-parent", "--format=%H %s", "-30"], {
    cwd: candidate,
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const marked = (line: string) => /^[0-9a-f]{40} (?:STAGE-ONLY OVERLAY|rehearsal:)/u.test(line);
  const firstUnmarked = commits.findIndex((line) => !marked(line));
  // Thirty marked commits with no base in reach is no overlay this record can measure.
  const overlay = firstUnmarked < 0 ? [] : commits.slice(0, firstUnmarked);
  const base = commits[overlay.length]?.slice(0, 40);
  if (!base || overlay.length === 0)
    return { base: base ?? null, commits: [], files: [], added: 0, removed: 0 };
  const files = execFileSync("git", ["diff", "--numstat", base, "HEAD"], {
    cwd: candidate,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split("\t");
      return { path: path ?? "", added: Number(added), removed: Number(removed) };
    });
  return {
    base: base.slice(0, 12),
    commits: overlay.map((line) => `${line.slice(0, 12)} ${line.slice(41)}`),
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

/**
 * The stage has no acceptance key, so the release's own accept can run its restart wait but never
 * its model calls, and ends not-serving there whatever the pool does. The verdict is the stage's.
 */
const healVerdictBasis =
  "the verdict is the signed inspect after the release: a new boot selected, the epoch moved, active-health 200 and no needs-a-person. The release's own accept is recorded beside it; on this stage it has no acceptance key, so its model calls cannot run and its not-serving line is expected, not this run's verdict";

/** Said in every heal record, beside `overlay`: what production will not run, and what follows. */
const healOverlayStatement = [
  "the candidate is the trial commit plus a stage-only overlay (`overlay`): production never runs that code, and a heal here proves the trial's mechanism with that overlay in place, not the exact release commit",
  "the overlay carries: the fault trigger (rehearsal-restart-over-running), the stage's database naming, the stage's observation token binding, the controller's wrap of a plain token, and the rehearsal stage handling in alchemy.run.ts (stack basalt-rehearsal, the stage's names and preview shape)",
  "the observation token reached the pool Worker as a plain Worker secret minted by the stage, not through the Secrets Store production uses; the controller presents it in the store binding's shape, so the heal's own reads (recovery, retirement, startup-abort, fleet and provider-observe) are unchanged",
  "the release's own accept: its restart wait compares against the stuck boot a signed inspect names, since the stage has no acceptance key and the boot command records only not-serving; its model calls cannot run without that key, so its not-serving line after a ready wait is expected and is not this run's verdict",
  "the fault command reads the root as not running, so the candidate's confirmed-stop guard admits the stuck state: a self-heal measures leaving that state, not that the candidate avoids entering it",
  "the stage's copy of the token and every plain secret also sit in the stage's own State rows, as production's do in its own",
];

/** The candidate a `release` run applies: a rehearse/ branch and one of its own policies. */
export function releaseCandidate(text: string) {
  const spec = JSON.parse(text) as { branch?: unknown; policy?: unknown };
  const branch = typeof spec.branch === "string" ? spec.branch : "";
  const policy = typeof spec.policy === "string" ? spec.policy : "";
  if (!/^rehearse\/[a-z0-9][a-z0-9.-]{0,80}$/u.test(branch))
    throw new Error("release-candidate.json names no rehearse/ branch");
  if (!/^[a-z0-9-]{1,40}$/u.test(policy))
    throw new Error("release-candidate.json names no release policy");
  return { branch, policy };
}

/**
 * One release of a candidate onto the stage, as production releases (lane 5's apply A, apply B and
 * the red run): its own entry, policy and stack, then a fresh plan. Around the apply: the pool
 * Worker versions it created, and the controller's selected boot before and after.
 */
async function stageRelease(
  lane: number,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  outputs: string,
  hooks: ReturnType<typeof nativeHooks>,
  kind: "release" | "classplan" = "release",
) {
  const named = releaseCandidate(
    await readFile(join(root, "scripts/release-preview/release-candidate.json"), "utf8"),
  );
  // The class change plans the same candidate under its own policy and fleet declaration.
  const policy = kind === "classplan" ? "cutover-classes" : named.policy;
  const { branch } = named;
  const result: Record<string, unknown> = { branch, policy, kind };
  const candidate = join(source.RUNNER_TEMP ?? root, "release-candidate");
  await rm(candidate, { recursive: true, force: true });
  execFileSync("git", ["fetch", "-q", "--depth", "30", "origin", branch], { cwd: root });
  execFileSync("git", ["worktree", "add", "-q", "--detach", candidate, "FETCH_HEAD"], {
    cwd: root,
  });
  result.candidate = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: candidate,
    encoding: "utf8",
  }).trim();
  if (!existsSync(join(candidate, `scripts/release/policies/${policy}.json`)))
    throw new Error(`The candidate has no ${policy} policy`);
  execFileSync("npm", ["run", "prepare:upstream"], { cwd: candidate, stdio: "ignore" });
  const bootOf = async (label: string) =>
    faultRead(lane, source, outputs, label, ["--read-only"]).then(
      (state) => (state.selection as { boot?: unknown; epoch?: unknown } | undefined) ?? null,
      (error: unknown) => ({ unreadable: error instanceof Error ? error.message : String(error) }),
    );
  result.bootBefore = await bootOf("release-before");
  const env = {
    ...(kind === "classplan" ? declaration.cutover : declaration.baseline),
    POOL_ROOT_IMAGE: await rootPin(hooks, subject, source),
  };
  if (kind === "classplan") {
    // Plan only, as production's read-only plan runs: a refusal is the result, kept in plain text
    // (redacted of secrets) because it names the blocking resource.
    await withStageBuild(candidate, subject, source, async () => {
      try {
        const planned = await runEntry("plan", subject, source, env, outputs, {
          policy,
          tree: candidate,
        });
        const rows =
          (planned.record as { changes?: { fqn: string; action: string }[] } | undefined)
            ?.changes ?? [];
        result.planPassed = true;
        result.planRows = rows.map((row) => `${row.fqn} ${row.action}`).slice(0, 200);
      } catch (error) {
        result.planPassed = false;
        result.planRefused = redactor(source)(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 4_000);
      }
      // Then two unscoped plans in a row with nothing applied between them: a row that stays
      // non-noop in both plans on every plan, which no release can settle.
      for (const label of ["unscoped-1", "unscoped-2"]) {
        const planned = await runEntry("plan", subject, source, env, outputs, {
          policy: null,
          include: null,
          tree: candidate,
        }).catch((error: unknown) => ({
          failed: redactor(source)(error instanceof Error ? error.message : String(error)).slice(
            0,
            1_000,
          ),
        }));
        const changes =
          (
            planned as {
              record?: {
                changes?: { fqn: string; type?: string; action: string; changedProps?: unknown }[];
              };
            }
          ).record?.changes ?? [];
        result[label] =
          "failed" in planned
            ? planned
            : changes.map(({ fqn, type, action, changedProps }) => ({
                fqn,
                type,
                action,
                changedProps,
              }));
      }
    });
    result.bootAfter = await bootOf("release-after");
    return result;
  }
  const { stage, stack } = stageNames(subject);
  const account = encodeURIComponent(source.CLOUDFLARE_ACCOUNT_ID ?? "");
  const headers = { Authorization: `Bearer ${source.CLOUDFLARE_API_TOKEN ?? ""}` };
  await withStageBuild(candidate, subject, source, async () => {
    const from = Date.now();
    try {
      result.release = await runEntry("deploy", subject, source, env, outputs, {
        policy,
        tree: candidate,
      });
    } catch (error) {
      const message = redactor(source)(error instanceof Error ? error.message : String(error));
      result.releaseFailed = message.slice(0, 4_000);
      result.changesRemainAfterApply = /ChangesRemainAfterApply|still differ/u.test(message);
    }
    const to = Date.now();
    result.window = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    result.poolWorkerVersions = await poolWorkerVersionsBetween({
      account,
      headers,
      stage,
      stack,
      from,
      to,
    }).then(
      ({ count, numbers }) => ({ count, numbers }),
      (error: unknown) => ({ unreadable: error instanceof Error ? error.message : String(error) }),
    );
    // The follow-up plan, unscoped: a converged release shows no pool Worker row.
    const planned = await runEntry("plan", subject, source, env, outputs, {
      policy: null,
      include: null,
      tree: candidate,
    }).catch((error: unknown) => ({
      failed: redactor(source)(error instanceof Error ? error.message : String(error)).slice(
        0,
        2_000,
      ),
    }));
    const rows =
      (planned as { record?: { changes?: { fqn: string; action: string }[] } }).record?.changes ??
      [];
    result.followUpPlan = "failed" in planned ? planned : { rows: rows.length };
    result.poolWorkerRowsAfter = rows.filter((row) => row.fqn === "PoolWorker");
  });
  result.bootAfter = await bootOf("release-after");
  return result;
}

async function healRelease(
  lane: number,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  outputs: string,
  hooks: ReturnType<typeof nativeHooks>,
) {
  const result: Record<string, unknown> = { reproduces: healReproduces };
  const probe = startProbe(lane, join(outputs, "probe-heal.jsonl"), source);
  // Seconds per phase, so the slow ones are named, not guessed.
  const phases: Record<string, number> = {};
  result.phases = phases;
  let mark = Date.now();
  const lap = (name: string) => {
    phases[name] = Math.round((Date.now() - mark) / 1000);
    mark = Date.now();
  };
  try {
    // 1. Production's stuck state, field for field: reuse a confirmed fault, or put one in place.
    const now = await faultRead(lane, source, outputs, "before", ["--read-only"]);
    await requireRestartBudget(subject, source, now, result);
    result.confirmed =
      now.stuck === true && now.policyCleanAndExpired === true
        ? { reused: true, state: now }
        : await faultAndConfirm(lane, subject, source, outputs);
    // Taken after the fault is confirmed, so it is never earlier than the restart's admission.
    const faultSettledAt = Date.now();
    lap("fault");
    // 2. The fix candidate in its own prepared checkout, built as the stage is built.
    const candidate = join(source.RUNNER_TEMP ?? root, "heal-candidate");
    await rm(candidate, { recursive: true, force: true });
    execFileSync("git", ["fetch", "-q", "--depth", "30", "origin", healCandidateBranch], {
      cwd: root,
    });
    execFileSync("git", ["worktree", "add", "-q", "--detach", candidate, "FETCH_HEAD"], {
      cwd: root,
    });
    result.candidate = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: candidate,
      encoding: "utf8",
    }).trim();
    // What the candidate is made of: its first-parent commits back to the stage's deployed commit.
    result.candidateComposition = execFileSync(
      "git",
      ["log", "--first-parent", "--format=%h %s", "-4"],
      { cwd: candidate, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    result.overlay = overlayExtent(candidate);
    result.overlayStatement = healOverlayStatement;
    if (existsSync(join(candidate, "scripts/release-preview/stage-fault.ts")))
      throw new Error("The heal candidate still carries the rehearsal-only fault command");
    execFileSync("npm", ["run", "prepare:upstream"], { cwd: candidate, stdio: "ignore" });
    lap("candidatePrepare");
    const env = { ...declaration.baseline, POOL_ROOT_IMAGE: await rootPin(hooks, subject, source) };
    const timing = (await import(
      pathToFileURL(join(candidate, "src/pool/runtime-slots/forced-restart-timing.ts")).href
    )) as {
      restartStartBoundMs: number;
      forcedRestartServesWithinHeldStreamsMs: number;
    };
    // Production's admission is a day old, so its forced stop takes the running container for the
    // old one at once. A stage restart's admission is seconds old: past `restartStartBoundMs` the
    // stage takes the same branch. Wait it out before releasing anything.
    const ownershipMarginMs = 30_000;
    const ownershipAt = faultSettledAt + timing.restartStartBoundMs + ownershipMarginMs;
    result.ownershipWaitMs = Math.max(0, ownershipAt - Date.now());
    if ((result.ownershipWaitMs as number) > 0)
      await new Promise((done) => setTimeout(done, result.ownershipWaitMs as number));
    lap("ownershipWait");
    const started = Date.now();
    // The healing release's policy; a candidate without it measures nothing the GO asks about.
    if (!existsSync(join(candidate, "scripts/release/policies/code-restart.json")))
      throw new Error("The heal candidate has no code-restart policy");
    await withStageBuild(candidate, subject, source, async () => {
      lap("stageBuild");
      // 3. The plan must not touch the root container application. The policy-free plan comes
      // first and is kept whole, so a refusal below still leaves every row the candidate plans.
      await writeStateEvidence(subject, source, outputs, "candidate");
      let rows: { fqn: string; type: string; action: string }[] = [];
      try {
        const all = await runEntry("plan", subject, source, env, outputs, {
          policy: null,
          include: null,
          tree: candidate,
        });
        rows = (all.record as { changes?: typeof rows }).changes ?? [];
        result.candidateRows = rows;
      } catch (error) {
        result.candidateRows = {
          failed: redactor(source)(error instanceof Error ? error.message : String(error)),
        };
      }
      await writeFile(
        join(outputs, "heal-candidate-rows.json"),
        `${JSON.stringify(result.candidateRows, null, 2)}\n`,
        { mode: 0o600 },
      );
      const onRoot = rows.filter(
        (row) => row.fqn === "PoolContainer" || row.type === "Cloudflare.Container",
      );
      result.rootRows = onRoot;
      if (onRoot.length)
        throw new Error(
          `The healing release plans changes on the root container: ${JSON.stringify(onRoot)}`,
        );
      lap("plan");
      // The candidate's own plan under its policy, as production plans before it deploys: its
      // root-settle check runs only here. A refusal changed nothing; it is the run's stop.
      try {
        const planned = await runEntry("plan", subject, source, env, outputs, {
          policy: "code-restart",
          tree: candidate,
        });
        result.policyPlan = (planned.record as { summary?: unknown }).summary ?? "planned";
      } catch (error) {
        result.policyPlanRefused = redactor(source)(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 4_000);
        throw error;
      }
      lap("policyPlan");
      // The release's own acceptance, as release.yml runs it from the candidate's own entry: the
      // serving versions and the root's boot before the apply, `accept` after it either way.
      const acceptEnv = {
        ...env,
        POOL_ACCEPTANCE_ORIGIN: previewStageOrigin(
          stageNames(subject).slug,
          source.TEST_STAGE_DOMAIN ?? "",
        ),
      };
      const servingFile = join(outputs, "heal-serving.json");
      const rootBootFile = join(outputs, "heal-root-boot.json");
      await runEntry("serving", subject, source, acceptEnv, outputs, {
        args: ["--fqn", "PoolWorker", "--out", servingFile],
        tree: candidate,
      });
      const bootCommandFile = join(outputs, "heal-root-boot-command.json");
      await runEntry("boot", subject, source, acceptEnv, outputs, {
        args: ["--out", bootCommandFile, "--allow-not-serving"],
        tree: candidate,
      }).catch((error: unknown) => {
        result.rootBootRefused = redactor(source)(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 1_000);
      });
      // The stage has no acceptance key, so the boot command can only say "not serving", and the
      // release's wait would then take the stuck boot for a new one. The boot it compares with is
      // the selected boot a signed read-only inspect names; the command's own answer stays beside it.
      await rm(rootBootFile, { force: true });
      await faultRead(
        lane,
        { ...source, STAGE_FAULT_BOOT_OUT: rootBootFile },
        outputs,
        "root-boot",
        ["--read-only"],
      );
      if (!existsSync(rootBootFile))
        throw new Error(
          "The stuck boot has no id in inspect; acceptance would have nothing to compare",
        );
      result.rootBootSource =
        "signed inspect, selected boot (the boot command records only not-serving here)";
      lap("servingAndBoot");
      // A healing release heals only while the pool's own alarm is alive: the alarm's upkeep
      // lines in the five minutes before the upload, and the last deadlines they name.
      result.alarmBeforeUpload = await workerLogLines(
        subject,
        source,
        Date.now() - 5 * 60_000,
        "POOL_RUNTIME_UPKEEP",
      ).then(
        (lines) => {
          const alarm = lines.filter((line) => line.side === "alarm");
          const deadlines = alarm.filter((line) => line.phase === "deadlines").at(-1);
          return {
            alive: alarm.length > 0,
            alarmLines: alarm.length,
            lastDeadlines: deadlines
              ? {
                  homeDeadline: deadlines.homeDeadline ?? null,
                  fleetDeadline: deadlines.fleetDeadline ?? null,
                  nativeDeadline: deadlines.nativeDeadline ?? null,
                }
              : null,
          };
        },
        (error: unknown) => ({
          unreadable: error instanceof Error ? error.message : String(error),
        }),
      );
      // The deploy plans again under the policy and stops in plan on any refusal. A release that
      // uploads and then fails its readiness check is recorded, and recovery is still watched: the
      // pool can heal while the release itself reports failure (the unfixed head's predicted red).
      const failure = join(outputs, "release-failure.txt");
      const failedBefore = (await readFile(failure, "utf8").catch(() => "")).length;
      try {
        result.release = await runEntry("deploy", subject, source, env, outputs, {
          policy: "code-restart",
          tree: candidate,
        });
      } catch (error) {
        result.releaseFailed = redactor(source)(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 4_000);
        result.releaseStopLines = (await readFile(failure, "utf8").catch(() => ""))
          .slice(failedBefore)
          .split(/\r?\n/u)
          .filter((line) => /Release stopped|eadiness|SlotRefused|identity|Unattested/u.test(line))
          .map((line) => redactor(source)(line).slice(0, 600))
          .slice(0, 12);
        // A refusal in plan changed nothing, so there is no recovery to watch.
        if (/stopped in plan/u.test(String(result.releaseFailed))) throw error;
      }
      lap("deploy");
      result.releaseAcceptance = await healAcceptance({
        candidate,
        subject,
        source,
        env: acceptEnv,
        outputs,
        servingFile,
        rootBootFile,
        apply: result.releaseFailed ? "failure" : "success",
      });
    });
    lap("acceptance");
    result.releaseSeconds = Math.round((Date.now() - started) / 1000);
    // 4. Recovery: wait, bounded, for the Worker's own restart to bring a new boot that answers.
    // Every read goes into a timeline: the boot the witness names (the restart's new boot N), the
    // boot the selection names, its epoch, active-health and the container. From it: seconds from
    // N first appearing to the selection committing it (the fix's 60 s clock lives in that gap).
    const confirmed =
      (result.confirmed as { before?: Record<string, unknown>; state?: Record<string, unknown> }) ??
      {};
    const pre = ((confirmed.before ?? confirmed.state)?.selection ?? {}) as {
      boot?: string | null;
      epoch?: number | null;
    };
    const timeline: Record<string, unknown>[] = [];
    result.timeline = timeline;
    // On a stage the restart's admission is seconds old, so a refusing root is taken for the old
    // one only after `restartStartBoundMs`; then the worst serve bound (streams held) runs. Both
    // come from the candidate's own timing module. The margin covers what those totals exclude:
    // the time `destroy()` takes and the membership pass that renews an expired pool policy.
    const stageMarginMs = 120_000;
    result.waitBoundMs =
      timing.restartStartBoundMs + timing.forcedRestartServesWithinHeldStreamsMs + stageMarginMs;
    const deadline = Date.now() + (result.waitBoundMs as number);
    let healed: Record<string, unknown> | undefined;
    let bootSeenAt: number | undefined;
    let committedAt: number | undefined;
    while (Date.now() < deadline) {
      const state = await faultRead(lane, source, outputs, "after", ["--read-only"]).catch(
        () => undefined,
      );
      const at = Date.now();
      const selection = (state?.selection ?? {}) as { boot?: string | null; epoch?: number | null };
      const witness = (state?.witness ?? {}) as { boot?: string | null };
      const health = (state?.activeHealth ?? {}) as { status?: number; reason?: string };
      timeline.push({
        atSeconds: Math.round((at - started) / 1000),
        epoch: selection.epoch ?? null,
        selectionBoot: selection.boot ?? null,
        witnessBoot: witness.boot ?? null,
        health: health.status ?? null,
        reason: health.reason ?? null,
        running: (state?.container as { running?: boolean } | undefined)?.running ?? null,
        // #1471 3eff0045+: the active-stream count and since when the stop waits for streams.
        recovery:
          (state?.recovery as { values?: Record<string, unknown> } | null | undefined)?.values ??
          null,
        // #1471 adfb37db+: recovery.streams, { active, stillSince }, by name.
        streams:
          ((state?.recovery as { values?: { streams?: unknown } } | null | undefined)?.values
            ?.streams as { active?: number; stillSince?: number | null } | undefined) ?? null,
      });
      const streams = Object.entries(
        (state?.recovery as { values?: Record<string, unknown> } | null | undefined)?.values ?? {},
      ).filter(([key, value]) => /stream/iu.test(key) && typeof value === "number" && value > 0);
      if (streams.length)
        result.nonZeroStreams = { atSeconds: Math.round((at - started) / 1000), streams };
      if (bootSeenAt === undefined && witness.boot) bootSeenAt = at;
      if (committedAt === undefined && selection.boot && selection.boot !== pre.boot)
        committedAt = at;
      // Healed is all of: active-health 200 on a new boot, at a moved epoch (needs-a-person is
      // read below and outranks it). A 200 on the stuck boot is recorded and the watch goes on.
      const moved =
        typeof selection.epoch === "number" &&
        typeof pre.epoch === "number" &&
        selection.epoch > pre.epoch;
      if (health.status === 200 && selection.boot && selection.boot !== pre.boot && moved) {
        healed = state;
        break;
      }
      if (health.status === 200 && result.healthyWithoutNewBoot === undefined)
        result.healthyWithoutNewBoot = {
          atSeconds: Math.round((at - started) / 1000),
          sameBoot: selection.boot === pre.boot,
          epochMoved: moved,
        };
      // A new boot that never commits ends, after forcedRestartBudgetMs, in needs-a-person: red, named.
      if (timeline.length % 10 === 0) {
        const needs = await workerLogLines(
          subject,
          source,
          started,
          "POOL_SELECTED_RECOVERY_NEEDS_PERSON",
        ).catch(() => []);
        if (needs.length) {
          result.needsPerson = needs;
          break;
        }
      }
      await new Promise((done) => setTimeout(done, 2_000));
    }
    // The watch reads needs-a-person only every tenth sample; a heal is judged with one more read.
    if (healed && !result.needsPerson) {
      const needs = await workerLogLines(
        subject,
        source,
        started,
        "POOL_SELECTED_RECOVERY_NEEDS_PERSON",
      ).catch(() => []);
      const values =
        (healed.recovery as { values?: Record<string, unknown> } | null | undefined)?.values ?? {};
      const held = Object.keys(values).find(
        (key) => /needs/iu.test(key) && values[key] !== null && values[key] !== undefined,
      );
      if (needs.length) result.needsPerson = needs;
      else if (held) result.needsPerson = [{ inspect: held }];
    }
    result.secondsBootToCommit =
      bootSeenAt !== undefined && committedAt !== undefined
        ? Math.round((committedAt - bootSeenAt) / 1000)
        : null;
    result.bootToCommitOver60 =
      typeof result.secondsBootToCommit === "number" && result.secondsBootToCommit > 60;
    result.stopPath = await forcedStopPath(subject, source, started).catch((error: unknown) => ({
      unavailable: error instanceof Error ? error.message : String(error),
      green: false,
    }));
    lap("recoveryWatch");
    // One named verdict, so a run is read from its record, not from the detail file.
    result.verdict = result.needsPerson
      ? "NEEDS_PERSON"
      : !healed
        ? "NOT_HEALED"
        : result.releaseFailed
          ? /eadiness/u.test(JSON.stringify(result.releaseStopLines ?? result.releaseFailed))
            ? "HEALED_RELEASE_FAILED_AT_READINESS"
            : "HEALED_RELEASE_FAILED"
          : "HEALED";
    if (result.needsPerson)
      throw new Error(
        `Recovery ended in needs-a-person: ${JSON.stringify(result.needsPerson).slice(0, 300)}`,
      );
    if (!healed)
      throw new Error(
        `Recovery did not report ready within ${Math.round((result.waitBoundMs as number) / 1000)} s of the release`,
      );
    result.healed = healed;
    result.secondsToReady = Math.round((Date.now() - started) / 1000);
    // (b): with no account on the stage, the first model request after the heal must get through
    // the runtime to account selection and fail only there. Recorded with its time.
    result.firstModel = await stageModel(subject, source);
    result.secondsToFirstModel = Math.round((Date.now() - started) / 1000);
    // Green only with exactly one stop, of the old boot, by graceful_exit or destroy_after_grace.
    if ((result.stopPath as { green?: boolean }).green !== true)
      throw new Error(
        `The stop lines are not one graceful_exit or destroy_after_grace: ${JSON.stringify(result.stopPath).slice(0, 400)}`,
      );
    // The pool healed; the release itself still has to have passed for a green heal.
    if (result.releaseFailed)
      throw new Error(
        `The pool healed but the release failed: ${String(result.releaseFailed).slice(0, 400)}`,
      );
  } finally {
    result.interruption = await probe.stop();
    // Kept whole even when the heal fails, so a red run still shows both the pool and the release.
    await writeFile(join(outputs, "heal-detail.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    }).catch(() => {});
    await writeFile(join(outputs, "stage-heal.json"), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return result;
}

/** One run of the rehearsal-only fault client; it writes its read as JSON to the private output. */
async function faultRead(
  lane: number,
  source: NodeJS.ProcessEnv,
  outputs: string,
  label: string,
  args: string[],
) {
  const out = join(outputs, `fault-${label}.json`);
  const code = await new Promise<number | null>((done) => {
    const child = spawn(
      "node",
      [join(root, "scripts/release-preview/stage-fault.ts"), String(lane), out, ...args],
      { cwd: root, env: source, stdio: ["ignore", "ignore", "ignore"] },
    );
    child.once("close", done);
  });
  const state = JSON.parse(await readFile(out, "utf8").catch(() => "null")) as Record<
    string,
    unknown
  > | null;
  if (code !== 0 || !state) throw new Error(`The fault client's ${label} read exited ${code}`);
  return state;
}

/** One model request on the stage's own pool, as its smoke user, with no provider account. */
function stageModel(subject: StageSubject, source: NodeJS.ProcessEnv) {
  return stageModelRequest({
    origin: previewStageOrigin(stageNames(subject).slug, source.TEST_STAGE_DOMAIN ?? ""),
    stage: stageNames(subject).stage,
    email: source.PREVIEW_SMOKE_EMAIL ?? "",
    password: source.PREVIEW_SMOKE_PASSWORD ?? "",
  });
}

/**
 * The fault, then production's stuck state confirmed field for field: the selection still names
 * the boot it named before the fault, at the same epoch and unfenced; the witness names a restart
 * with no boot; the container runs; active-health refuses on slot identity; every clean policy has
 * lapsed (on today's code 15 to 20 s after the fault, so this waits rather than ages it).
 */
async function faultAndConfirm(
  lane: number,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  outputs: string,
) {
  const before = await faultRead(lane, source, outputs, "pre", ["--read-only"]);
  const pre = before.selection as { boot?: string | null; epoch?: number | null } | undefined;
  const sent = await faultRead(lane, source, outputs, "send", []);
  const sentAt = Date.now() - 60_000;
  const deadline = Date.now() + 240_000;
  let state: Record<string, unknown> = sent;
  let startRefusal: Record<string, unknown> | undefined;
  let endpointLines: Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    state = await faultRead(lane, source, outputs, "confirm", ["--read-only"]);
    // Item 4: the running root answered recovery's start with another launch than the restart's.
    endpointLines = await workerLogLines(
      subject,
      source,
      sentAt,
      "POOL_RUNTIME_ENDPOINT_FAILURE",
    ).catch(() => endpointLines);
    startRefusal = endpointLines.find(
      (line) =>
        line.method === "POST" &&
        line.path === "/start" &&
        JSON.stringify(line).includes("runtime_endpoint_route_slot_identity"),
    );
    if (state.stuck === true && state.policyCleanAndExpired === true && startRefusal) break;
    await new Promise((done) => setTimeout(done, 10_000));
  }
  const selection = state.selection as { boot?: string | null; epoch?: number | null } | undefined;
  const mismatches = [
    ...(state.stuck === true ? [] : ["not stuck"]),
    ...(state.policyCleanAndExpired === true ? [] : ["policy not clean and expired"]),
    ...(selection?.boot && selection.boot === pre?.boot
      ? []
      : ["selection no longer names the pre-fault boot"]),
    ...(selection?.epoch === pre?.epoch ? [] : ["selection epoch moved"]),
    ...(startRefusal
      ? []
      : [
          "no POOL_RUNTIME_ENDPOINT_FAILURE on POST /start refusing runtime_endpoint_route_slot_identity",
        ]),
  ];
  // Item 5: on b121+ code the stuck runtime answers a model request with the native retry advice.
  const model = await stageModel(subject, source);
  if (
    !(
      model.ok &&
      model.status === 503 &&
      model.retryAfter &&
      /Please retry this request/u.test(model.body)
    )
  )
    mismatches.push(
      `the model request did not get the 503 retry advice: ${JSON.stringify(model).slice(0, 300)}`,
    );
  // The stage root's readiness answer as the endpoint saw it (status, launch headers), for the
  // controller owner's comparison with production's old container.
  const confirmed = {
    before,
    state,
    startRefusal: startRefusal ?? null,
    endpointLines,
    model,
    mismatches,
    at: new Date().toISOString(),
  };
  await writeFile(
    join(outputs, "fault-confirmed.json"),
    `${JSON.stringify(confirmed, null, 2)}\n`,
    { mode: 0o600 },
  );
  if (mismatches.length)
    throw new Error(`The stage is not in production's stuck state: ${mismatches.join("; ")}`);
  return confirmed;
}

/** This stage's PoolWorker log events since `from` whose message contains `needle`, as JSON payloads. */
async function workerLogLines(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  from: number,
  needle: string,
) {
  const account = encodeURIComponent(source.CLOUDFLARE_ACCOUNT_ID ?? "");
  const headers = { Authorization: `Bearer ${source.CLOUDFLARE_API_TOKEN ?? ""}` };
  const { stage, stack } = stageNames(subject);
  // This stage's one pool Worker, by its stack, stage and logical-id tags; names carry no stage token.
  const script = stageWorker(await workerScripts(account, headers), stage, "PoolWorker", stack);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryId: `rehearsal-${needle.toLowerCase()}-${Date.now()}`,
        timeframe: { from, to: Date.now() },
        view: "events",
        limit: 50,
        parameters: {
          filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: script }],
          needle: { value: needle, isRegex: false, matchCase: true },
        },
      }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`Workers Logs query refused with HTTP ${response.status}`);
  const plain = text.replace(/\\"/gu, '"');
  const lines: Record<string, unknown>[] = [];
  for (const match of plain.matchAll(
    new RegExp(`${needle}[^{]{0,8}(\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\})`, "gu"),
  ))
    try {
      lines.push(JSON.parse(match[1]!) as Record<string, unknown>);
    } catch {
      lines.push({ unparsed: match[1]!.slice(0, 400) });
    }
  return lines.slice(0, 50);
}

/** The fix's stop lines: exactly one, of the old boot, by a graceful exit or a destroy after grace. */
async function forcedStopPath(subject: StageSubject, source: NodeJS.ProcessEnv, from: number) {
  const lines = await workerLogLines(subject, source, from, "POOL_RUNTIME_FORCED_STOP");
  const paths = lines
    .map((line) => line.path)
    .filter((path): path is string => typeof path === "string");
  // Zero or more declined stops (POOL_SELECTED_RECOVERY phase stop_declined) may come first.
  const recovery = await workerLogLines(subject, source, from, "POOL_SELECTED_RECOVERY").catch(
    () => [] as Record<string, unknown>[],
  );
  const phases: Record<string, number> = {};
  for (const line of recovery) {
    const phase =
      typeof line.phase === "string"
        ? line.phase
        : /"phase":"([a-z_]+)"/u.exec(JSON.stringify(line))?.[1];
    if (phase) phases[phase] = (phases[phase] ?? 0) + 1;
  }
  const green =
    paths.length === 1 && (paths[0] === "graceful_exit" || paths[0] === "destroy_after_grace");
  return { paths, count: lines.length, lines, phases, recoveryLines: recovery.slice(0, 20), green };
}

/** The commit the stage last deployed, from its readiness command's recorded input; refuse any other HEAD. */
/** The State rows the 21-row noise is measured against, private, as `state-rows-<label>.json`. */
async function writeStateEvidence(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  outputs: string,
  label: string,
) {
  const config = stageEnvironment(subject, source);
  const stacks = await alchemyPreviewStateReader({ environment: config.deploy }).read(config.stage);
  await writeFile(
    join(outputs, `state-rows-${label}.json`),
    `${JSON.stringify(stateEvidence(stacks[stageNames(subject).stack] ?? []), null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function requireDeployedHead(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  { clientOnly = false }: { clientOnly?: boolean } = {},
) {
  const config = stageEnvironment(subject, source);
  const stacks = await alchemyPreviewStateReader({ environment: config.deploy }).read(config.stage);
  const row = (stacks[stageNames(subject).stack] ?? []).find((entry) =>
    entry.path.endsWith("/PoolBackendBudgetRuntimeReady"),
  )?.value;
  const found: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 6) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      if (key === "GITHUB_SHA" && typeof item === "string") found.push(item);
      else walk(item, depth + 1);
  };
  walk(row, 0);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const recorded = [...new Set(found)];
  if (recorded.length !== 1 || !/^[0-9a-f]{40}$/u.test(recorded[0]!))
    throw new Error(
      `The stage records ${recorded.length} deployed commits; run stage-baseline from this head first`,
    );
  // fault and heal deploy nothing from this checkout: a head that differs from the deployed commit
  // only in the rehearsal's own client scripts (never deployed) measures the same stage.
  if (recorded[0] !== head && clientOnly) {
    // After a heal the stage runs the heal candidate itself, and the self-heals and the next fault
    // measure that Worker. Only the branch's current head counts, read from origin, never a guess.
    const candidate = execFileSync(
      "git",
      ["ls-remote", "origin", `refs/heads/${healCandidateBranch}`],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split(/\s+/u)[0];
    if (candidate && recorded[0] === candidate) return recorded[0]!;
    execFileSync("git", ["fetch", "-q", "--depth", "1", "origin", recorded[0]!], { cwd: root });
    const changed = execFileSync("git", ["diff", "--name-only", recorded[0]!, head], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    if (changed.every((path) => path.startsWith("scripts/release-preview/"))) return recorded[0]!;
    throw new Error(
      `The stage last deployed ${recorded[0]!.slice(0, 12)}; this head changes deployed code too: ${changed
        .filter((path) => !path.startsWith("scripts/release-preview/"))
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  if (recorded[0] !== head)
    throw new Error(
      `The stage last deployed ${recorded[0]!.slice(0, 12)}, not this head ${head.slice(0, 12)}; run stage-baseline from this head first`,
    );
  return head;
}

/**
 * The stage's legacy-root pin, read the way production's preflight reads it: the root application's
 * image by digest, and the build input PoolWorker already knows it by (`POOL_IMAGE_HASH`).
 */
async function rootPin(
  hooks: ReturnType<typeof nativeHooks>,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
) {
  // P1c's source: PoolContainer's State row records the image digest Alchemy published and the
  // build input (`hash.image`) the controller knows the root by. The registry tag can be gone.
  const config = stageEnvironment(subject, source);
  const stacks = await alchemyPreviewStateReader({ environment: config.deploy }).read(config.stage);
  const row = (stacks[stageNames(subject).stack] ?? []).find((entry) =>
    entry.path.endsWith("/PoolContainer"),
  )?.value as
    | { attr?: { configuration?: { image?: string }; hash?: { image?: string; digest?: string } } }
    | undefined;
  const reference = row?.attr?.configuration?.image ?? "";
  const digest = row?.attr?.hash?.digest ?? "";
  const repository =
    /^(registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9/_-]+)(?::[^/@]+|@sha256:[a-f0-9]{64})$/u.exec(
      reference,
    )?.[1];
  if (!repository || !/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new Error(
      "PoolContainer's State row has no image digest and build input to pin the root by",
    );
  // The pin's input is the build input PoolWorker already knows the root by (`POOL_IMAGE_HASH`);
  // the preflight compares exactly that pair.
  const live = (await hooks.readBack("root-pin")).plainText?.POOL_IMAGE_HASH ?? "";
  if (!/^[a-f0-9]{16}$/u.test(live))
    throw new Error("PoolWorker has no 16-hex POOL_IMAGE_HASH to pin the root by");
  return JSON.stringify({ image: `${repository}@${digest}`, input: live });
}

export async function runStageMode(mode: StageMode, lane: number, source = process.env) {
  if (source.GITHUB_ACTIONS !== "true")
    throw new Error("Standing stages run only in GitHub Actions");
  const subject = laneSubject(lane);
  const { stage } = stageNames(subject);
  const outputs = resolve(source.BASALT_STAGE_OUTPUT_DIR ?? join(root, ".local/stage"));
  await mkdir(outputs, { recursive: true, mode: 0o700 });
  const hooks = nativeHooks({
    root,
    previousRoot: root,
    subject,
    deployEnvironment: source,
    deployBaseline: async () => {},
    build: async () => {},
    serve: async () => undefined,
  });
  const started = Date.now();
  const result: Record<string, unknown> = {
    mode,
    lane,
    stage,
    // First in every heal record: what the verdict rests on, and what it does not.
    ...(mode === "heal" ? { verdictBasis: healVerdictBasis } : {}),
  };
  // Each job re-plans the stage's manifest unless the workflow already did; identity derives from the state key.
  if (!existsSync(manifestPath(root, subject))) await planStage(root, subject, source);
  const run = async () => {
    if (mode === "baseline") {
      await budgetProbe(subject, source, outputs);
      // #1491's acceptance: the root application's version must not move across an apply that changes
      // nothing on it. Read before (a fresh stage has none) and after.
      const rootVersion = (read: NativeReadBack) =>
        read.applications.find((application) => application.className === "PoolContainer")
          ?.version ?? null;
      result.rootVersionBefore = await hooks
        .readBack("before-baseline")
        .then(rootVersion)
        .catch(() => null);
      const env: NodeJS.ProcessEnv = { ...source, ...declaration.baseline };
      // A lane may carry an explicit root image (lane 2: production's 16 Nov image by digest). It
      // replaces the pin read from the stage's own State, so one baseline rolls the root onto it.
      const explicit = composeRootPin(
        source[`REHEARSAL_ROOT_IMAGE_${lane}`],
        source.CLOUDFLARE_ACCOUNT_ID,
      );
      if (explicit) {
        Object.assign(env, { POOL_ROOT_IMAGE: explicit });
        result.rootPin = "secret";
      }
      try {
        try {
          await deployStage(root, subject, env);
        } catch (error) {
          // An existing stage: deploy it again with the root pinned, as production's root is. No policy
          // here, so the root may roll once; every later policy run then sees the pinned form.
          if (error instanceof Error && /existing remote state/u.test(error.message)) {
            // A stage whose PoolWorker never deployed has no root identity yet: deploy it unpinned first.
            const pin = explicit ?? (await rootPin(hooks, subject, source).catch(() => undefined));
            if (pin) Object.assign(env, { POOL_ROOT_IMAGE: pin });
            result.rootPinned = Boolean(pin);
          }
          // A standing stage that already has state (a partial or earlier baseline) is deployed again
          // the ordinary way; Alchemy resumes from its state.
          if (!(error instanceof Error && /existing remote state/u.test(error.message)))
            throw error;
          await withStageBuild(root, subject, env, async () => {});
          await redeployStage(root, subject, env, {
            ...declaration.baseline,
            ...(env.POOL_ROOT_IMAGE ? { POOL_ROOT_IMAGE: env.POOL_ROOT_IMAGE } : {}),
          });
          result.redeployed = true;
        }
      } finally {
        // Recorded even when the apply stops at its post-apply check.
        result.rootVersionAfter = await hooks
          .readBack("after-baseline")
          .then(rootVersion)
          .catch(() => null);
      }
      const read = await hooks.readBack("baseline");
      requireBaselineShape(read);
      result.readBack = read;
    } else if (mode === "plan") {
      const pin = await rootPin(hooks, subject, source);
      const env = { ...declaration.cutover, POOL_ROOT_IMAGE: pin };
      // R0: the cutover's own policy decides. A refusal is the result too; its detail stays private.
      try {
        result.plan = await runEntry("plan", subject, source, env, outputs);
      } catch (error) {
        result.planRefused = redactor(source)(
          error instanceof Error ? error.message : String(error),
        );
      }
      // Then two plans in a row with nothing applied between them: rows that differ or stay
      // non-noop across both are the never-settling ones. Each keeps its changedProps privately.
      for (const label of ["noise-1", "noise-2"]) {
        const planned = await runEntry("plan", subject, source, env, outputs, { policy: null });
        await writeFile(
          join(outputs, `plan-${label}.json`),
          `${JSON.stringify(planned.record, null, 2)}\n`,
          { mode: 0o600 },
        );
        result[label] = (planned.record as { planned?: unknown }).planned;
      }
      if (result.planRefused) {
        await writeFile(join(outputs, "stage-plan.json"), `${JSON.stringify(result, null, 2)}\n`, {
          mode: 0o600,
        });
        throw new Error(`R0 refused by the cutover policy:\n${String(result.planRefused)}`);
      }
    } else if (mode === "apply") {
      result.before = await hooks.readBack("before-apply");
      const pin = await rootPin(hooks, subject, source);
      // Controller availability and the root's identity, sampled every 2 s across the apply.
      const probe = startProbe(lane, join(outputs, "probe.jsonl"), source);
      try {
        result.apply = await runEntry(
          "deploy",
          subject,
          source,
          { ...declaration.cutover, POOL_ROOT_IMAGE: pin },
          outputs,
        );
      } finally {
        result.interruption = await probe.stop();
      }
      const after = await hooks.readBack("cutover");
      requireCutoverShape(after);
      result.after = after;
      result.replan = await runEntry(
        "plan",
        subject,
        source,
        { ...declaration.cutover, POOL_ROOT_IMAGE: pin },
        outputs,
      );
    } else if (mode === "code") {
      // P2-pre: a code-only PoolWorker release as a version upload that can be rolled back. The diff is
      // one exported marker in PoolWorker's entry module: a real bundle change with no behaviour.
      const pin = await rootPin(hooks, subject, source);
      const env = { ...declaration.baseline, POOL_ROOT_IMAGE: pin };
      const serving = join(outputs, "serving.json");
      await runEntry("serving", subject, source, env, outputs, {
        args: ["--fqn", "PoolWorker", "--out", serving],
      });
      result.serving = JSON.parse(await readFile(serving, "utf8")) as unknown;
      const workerPath = join(root, "src/pool/worker.ts");
      const original = await readFile(workerPath, "utf8");
      await writeFile(
        workerPath,
        `${original}\nexport const rehearsalCodeMarker = ${JSON.stringify(`${source.GITHUB_RUN_ID ?? "local"}-${Date.now()}`)};\n`,
      );
      const probe = startProbe(lane, join(outputs, "probe-code.jsonl"), source);
      let releaseError: unknown;
      try {
        result.release = await runEntry("deploy", subject, source, env, outputs, {
          policy: "cutover-code",
        });
      } catch (error) {
        // The version may be live even when the entry stops after its apply (e.g. a post-apply
        // check); the rollback below runs either way, then this failure is reported.
        releaseError = error;
        result.releaseRefused = redactor(source)(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        await writeFile(workerPath, original);
        result.releaseInterruption = await probe.stop();
      }
      const after = join(outputs, "serving-after.json");
      await runEntry("serving", subject, source, env, outputs, {
        args: ["--fqn", "PoolWorker", "--out", after],
      });
      result.servingAfter = JSON.parse(await readFile(after, "utf8")) as unknown;
      const back = startProbe(lane, join(outputs, "probe-rollback.jsonl"), source);
      try {
        await runEntry("rollback", subject, source, env, outputs, { args: ["--from", serving] });
      } finally {
        result.rollbackInterruption = await back.stop();
      }
      const final = join(outputs, "serving-final.json");
      await runEntry("serving", subject, source, env, outputs, {
        args: ["--fqn", "PoolWorker", "--out", final],
      });
      result.servingFinal = JSON.parse(await readFile(final, "utf8")) as unknown;
      await writeFile(join(outputs, "stage-code.json"), `${JSON.stringify(result, null, 2)}\n`, {
        mode: 0o600,
      });
      if (JSON.stringify(result.servingFinal) !== JSON.stringify(result.serving))
        throw new Error("The rollback did not restore the version that served before the release");
      if (releaseError) throw releaseError;
    } else if (mode === "settle") {
      // The plan-settles acceptance, plan only: two code-policy plans at the deployed commit (zero
      // rows), one Worker source change (that Worker only), one new migration file (the migration,
      // its connection and the Workers bound to it). Each keeps its rows or its refusal privately.
      const env = {
        ...declaration.baseline,
        POOL_ROOT_IMAGE: await rootPin(hooks, subject, source),
      };
      const plan = async (label: string) => {
        await rm(join(outputs, "release-failure.txt"), { force: true });
        let rows: unknown;
        try {
          const planned = await runEntry("plan", subject, source, env, outputs, { policy: "code" });
          const record = planned.record as { changes?: unknown; planned?: unknown };
          rows = record.changes ?? record.planned ?? [];
        } catch {
          rows = {
            refused: await readFile(join(outputs, "release-failure.txt"), "utf8").catch(
              () => "no detail",
            ),
          };
        }
        // The same plan without a policy: every changed row with its changedProps, refused or not.
        let all: unknown;
        try {
          const planned = await runEntry("plan", subject, source, env, outputs, {
            policy: null,
            include: null,
          });
          all = (planned.record as { changes?: unknown }).changes ?? [];
        } catch (error) {
          all = {
            failed: redactor(source)(error instanceof Error ? error.message : String(error)),
          };
        }
        await writeFile(
          join(outputs, `settle-${label}-rows.json`),
          `${JSON.stringify(all, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        await writeFile(
          join(outputs, `settle-${label}.json`),
          `${JSON.stringify(rows, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        result[label] = rows;
      };
      const edited = async (path: string, change: (text: string) => string, label: string) => {
        const original = existsSync(path) ? await readFile(path, "utf8") : undefined;
        await writeFile(path, change(original ?? ""));
        try {
          await plan(label);
        } finally {
          if (original === undefined) await rm(path, { force: true });
          else await writeFile(path, original);
        }
      };
      const marker = JSON.stringify(`${source.GITHUB_RUN_ID ?? "local"}-${Date.now()}`);
      await plan("deployed-1");
      await plan("deployed-2");
      await edited(
        join(root, "src/router.ts"),
        (text) => `${text}\nexport const rehearsalSettleMarker = ${marker};\n`,
        "one-worker-router",
      );
      await edited(
        join(cloud, "src/infrastructure/production-ops/migrations/zz-rehearsal-settle-marker.ts"),
        () =>
          `// Rehearsal-only marker: a new file where migrations live. Never committed.\nexport const marker = ${marker};\n`,
        "new-migration-file",
      );
    } else if (mode === "fault") {
      await writeStateEvidence(subject, source, outputs, "deployed");
      await requireRestartBudget(
        subject,
        source,
        await faultRead(lane, source, outputs, "budget", ["--read-only"]),
        result,
      );
      Object.assign(result, await faultAndConfirm(lane, subject, source, outputs));
    } else if (mode === "release") {
      Object.assign(result, await stageRelease(lane, subject, source, outputs, hooks));
    } else if (mode === "classplan") {
      Object.assign(result, await stageRelease(lane, subject, source, outputs, hooks, "classplan"));
    } else if (mode === "heal") {
      result.reproduces = healReproduces;
      Object.assign(result, await healRelease(lane, subject, source, outputs, hooks));
    } else if (mode === "secrets") {
      // Read-only: the account's Secrets Stores and secret names, privately; counts in public.
      Object.assign(result, await readSecretsStores(source, outputs, stage));
    } else if (mode === "diagnose") {
      // Read-only: the pool app's own answers and this stage's Workers' events, kept privately.
      Object.assign(result, await diagnoseStagePool(subject, source, outputs));
    } else if (mode === "adopt") {
      // Pin first, then adopt: a root rolled after adoption can never be restarted by recovery.
      // The adopt is one-way: it only runs against the lane's own pin, checked field for field.
      const pin = composeRootPin(
        source[`REHEARSAL_ROOT_IMAGE_${lane}`],
        source.CLOUDFLARE_ACCOUNT_ID,
      );
      if (!pin) throw new Error(`Adopt needs the lane's root pin (REHEARSAL_ROOT_IMAGE_${lane})`);
      result.before = await faultRead(lane, source, outputs, "before-adopt", ["--read-only"]);
      // No seed unless asked for: nothing then goes to the pool app or creates a pool.
      const withSeed = source.REHEARSAL_ADOPT_SEED === "infra-only";
      result.seed = withSeed ? "infra-only" : "none";
      Object.assign(
        result,
        await (withSeed ? seedAndAdopt : adoptWithoutSeed)({
          root,
          subject,
          source,
          outputs,
          deployedCommit: String(result.deployedCommit),
          pin: JSON.parse(pin) as { image: string; input: string },
          stackEnv: { ...declaration.baseline, POOL_ROOT_IMAGE: pin },
          controllerPolicies:
            (result.before as { policies?: { count?: number } }).policies?.count ?? -1,
        }),
      );
      // The state the heal proof needs before any fault: a selection, health, the pinned root.
      result.after = await faultRead(lane, source, outputs, "after-adopt", ["--read-only"]);
    } else if (mode === "destroy") {
      await destroyStage(root, subject, source);
      await verifyStageAbsent(root, subject, source);
      result.absent = true;
    }
  };
  // A failed mode still leaves what it read (a baseline's root versions, a plan's rows).
  try {
    if (
      mode === "plan" ||
      mode === "apply" ||
      mode === "code" ||
      mode === "settle" ||
      mode === "fault" ||
      mode === "heal" ||
      mode === "adopt"
    ) {
      // A plan measures the deployed commit only if it is that commit, built as the stage is built.
      // The heal release builds its own candidate checkout, so it only checks the deployed commit.
      result.deployedCommit = await requireDeployedHead(subject, source, {
        clientOnly: mode === "fault" || mode === "heal",
      });
      if (mode === "heal" || mode === "fault") await run();
      else await withStageBuild(root, subject, source, run);
    } else await run();
  } catch (error) {
    result.failed = redactor(source)(error instanceof Error ? error.message : String(error)).slice(
      0,
      4_000,
    );
    throw error;
  } finally {
    result.seconds = Math.round((Date.now() - started) / 1000);
    await writeFile(join(outputs, `stage-${mode}.json`), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    if (source.GITHUB_STEP_SUMMARY)
      await appendFile(
        source.GITHUB_STEP_SUMMARY,
        `**${mode}** on \`${stage}\`: ${result.seconds}s${result.failed ? " (failed)" : ""}\n\n\`\`\`json\n${redactor(source)(JSON.stringify(result.plan ?? result.apply ?? result.readBack ?? result, null, 2)).slice(0, 60_000)}\n\`\`\`\n`,
      );
  }
  return result;
}

/** Every file the run kept, sealed with the stage's key so the artifact holds no readable output. */
export async function sealOutputs(lane: number, out: string, source = process.env) {
  const directory = resolve(source.BASALT_STAGE_OUTPUT_DIR ?? join(root, ".local/stage"));
  const { readdir } = await import("node:fs/promises");
  const files: Record<string, string> = {};
  for (const name of await readdir(directory).catch(() => [] as string[]))
    files[name] = await readFile(join(directory, name), "utf8");
  const { gzipSync } = await import("node:zlib");
  // The seal holds 1 MiB; logs compress well, and a run too big for it keeps each file's last part.
  let packed = gzipSync(JSON.stringify(files));
  for (let keep = 4 * 1024 * 1024; packed.length > 1024 * 1024 && keep >= 64 * 1024; keep /= 2)
    packed = gzipSync(
      JSON.stringify(
        Object.fromEntries(Object.entries(files).map(([name, text]) => [name, text.slice(-keep)])),
      ),
    );
  await writeFile(out, sealManifest(packed, source.PREVIEW_STATE_KEY ?? "", laneSubject(lane)), {
    mode: 0o600,
  });
}

/** Each kept child output's reason lines and last lines, redacted, for the public job log. */
export async function showOutputs(source = process.env) {
  const directory = resolve(source.BASALT_STAGE_OUTPUT_DIR ?? join(root, ".local/stage"));
  const { readdir } = await import("node:fs/promises");
  const redact = redactor(source);
  for (const name of (await readdir(directory).catch(() => [] as string[])).sort()) {
    if (!name.endsWith(".log")) continue;
    const lines = (await readFile(join(directory, name), "utf8"))
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !/^\s+at .*(?:\(|file:|node:|<anonymous>)/u.test(line));
    const reasons = lines.filter((line) =>
      /stopped|refus|error|fail|defect|timed? ?out/iu.test(line),
    );
    console.log(`::group::${name} (${lines.length} lines; reasons, then the last 200)`);
    console.log(redact([...reasons.slice(-60), "----", ...lines.slice(-200)].join("\n")));
    console.log("::endgroup::");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "show-output") {
  await showOutputs();
} else if (
  process.argv[1] === fileURLToPath(import.meta.url) &&
  process.argv[2] === "seal-output"
) {
  await sealOutputs(stageLabel(process.argv[3] ?? "")?.lane ?? 0, process.argv[4] ?? "");
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = stageLabel(process.argv[2] ?? "");
  try {
    if (!parsed) throw new Error(`Usage: stage.ts stage-<${stageModes.join("|")}>[-2|-3]`);
    const result = await runStageMode(parsed.mode, parsed.lane);
    console.log(redactor(process.env)(JSON.stringify(result)));
  } catch (error) {
    console.error(describeError(error, redactor(process.env)));
    process.exitCode = 1;
  }
}
