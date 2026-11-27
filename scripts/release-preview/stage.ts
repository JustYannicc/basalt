/**
 * One mode against a standing rehearsal stage, so an attempt replays only what it tests:
 *
 *   check     setup and credentials only; touches nothing
 *   baseline  deploy the stage the way production is today (fleet classes absent)
 *   plan      R0: the cutover's plan, `--include PoolWorker` with the fleet declared; applies nothing
 *   apply     R1: the same deploy applied, read back, then planned again (must be all noop)
 *   destroy   tear the stage down and prove it gone
 *   leftovers read-only: what State still holds for the four-digit stages from before the lanes
 *   retire    destroy the next of those stages whose own rows prove it is its own
 *
 * Every apply and destroy goes through the release entry (`scripts/release/deploy.ts`), which never
 * lets Alchemy bootstrap the shared State store; nothing here runs the CLI with `--yes`.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewStageOrigin, stageEnvironment } from "../environment.ts";
import { stageModelRequest } from "./stage-model.ts";
import { recordedOrigins, recordedWorkerProps, stateEvidence } from "./stage-rows.ts";
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
import {
  alchemyPreviewStateReader,
  readNumberedRehearsalStages,
  readProductionRecords,
} from "../preview/inventory.ts";
import {
  leftoversProof,
  proveStages,
  retirePlan,
  retireSubject,
  timed,
  type RetireRefusal,
} from "./retire-stage.ts";
import { summarize, type Sample } from "./stage-probe.ts";
import { manifestPath } from "./checkpoint.ts";
import { sealManifest } from "./manifest.ts";
import { nativeHooks } from "./rehearsal-native-hooks.ts";
import { composeRootPin } from "./stage-pin.ts";
import { adoptWithoutSeed, seedAndAdopt } from "./stage-seed.ts";
import { diagnoseStagePool, stageWorker, workerScripts } from "./stage-diagnose.ts";
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
  "stateread",
  "leftovers",
  "retire",
  "redrelease",
  "retry",
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

export const candidateTreeRefusal =
  "This harness releases no candidate tree: a candidate from another lineage could deploy outside the lane's stack, which the lane's destroy never reads; nothing is checked out or deployed.";

/**
 * Every mode that would release another tree onto the stage calls this before it checks out,
 * prepares or runs anything of that tree. No check of a candidate's own stack file proved sound,
 * so none is admitted until the harness can destroy whatever a candidate released.
 */
function refuseCandidateTree(): never {
  throw new Error(candidateTreeRefusal);
}

export async function runEntry(
  command: "plan" | "deploy" | "apply" | "serving" | "rollback" | "boot" | "accept",
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
    /** The tree whose entry runs; anything but the harness's own is refused. */
    tree?: string;
  } = {},
) {
  // A second line behind the modes' own refusal, before the stage env is composed.
  if (tree !== root) refuseCandidateTree();
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
        ...((command === "plan" || command === "deploy" || command === "apply") && policy
          ? ["--policy", join(tree, `scripts/release/policies/${policy}.json`)]
          : []),
        // Without a policy, the cutover's include still scopes the plan to PoolWorker and its inputs.
        ...((command === "plan" || command === "deploy" || command === "apply") &&
        !policy &&
        include
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
          ...extra,
          ...rollbackPolicyEnv(command, policy),
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

// The heal candidate on the re-cut repair batch (batch/healing at 251c1d4a) plus the stage-only
// overlay; a stage an earlier heal released may still run it. A new name per base: a candidate
// branch is never force-pushed.
export const healCandidateBranch = "rehearse/heal-candidate-251c1d4";

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

// A candidate release needs a redesign in which the candidate destroys what it released; git
// history holds the old code.
/** release and classplan: a candidate branch released, or planned, onto the stage. */
export function stageRelease(): never {
  return refuseCandidateTree();
}

/** redrelease: a red commit on a candidate, released and rolled back by its own entry. */
export function redRelease(): never {
  return refuseCandidateTree();
}

/** retry: the red release's refused rollback, once more, by the candidate's own entry. */
export function rollbackRetry(): never {
  return refuseCandidateTree();
}

/** heal: the fix candidate's code-only release onto a faulted stage. */
export function healRelease(): never {
  return refuseCandidateTree();
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
  // A fault deploys nothing from this checkout: a head that differs from the deployed commit
  // only in the rehearsal's own client scripts (never deployed) measures the same stage.
  if (recorded[0] !== head && clientOnly) {
    // A stage an earlier heal released runs the heal candidate itself, and a fault measures that
    // Worker. Only the branch's current head counts, read from origin, never a guess.
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
  // Before anything else: no env check, fetch, State read, plan or output.
  if (mode === "release" || mode === "classplan") stageRelease();
  if (mode === "redrelease") redRelease();
  if (mode === "retry") rollbackRetry();
  if (mode === "heal") healRelease();
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
  };
  // Kept only in the private `stage-<mode>.json`, never in the public record.
  const privateOnly: Record<string, unknown> = {};
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
    } else if (mode === "stateread") {
      // Read-only: the five Workers that plan as updates with no changed prop, as State records
      // them. Private output only; the public record keeps their statuses.
      const config = stageEnvironment(subject, source);
      const stacks = await alchemyPreviewStateReader({ environment: config.deploy }).read(
        config.stage,
      );
      const rows = stacks[stageNames(subject).stack] ?? [];
      const origins = recordedOrigins(rows, ["DatabaseConnection", "PoolModelDatabaseConnection"]);
      const recorded = recordedWorkerProps(rows, [
        "Sso",
        "Api",
        "Dashboard",
        "McpServer",
        "Marketing",
      ]);
      await writeFile(
        join(outputs, "state-workers.json"),
        `${JSON.stringify({ workers: recorded, origins }, null, 2)}\n`,
        { mode: 0o600 },
      );
      result.statuses = Object.fromEntries(
        Object.entries(recorded).map(([fqn, row]) => [fqn, (row as { status: unknown }).status]),
      );
    } else if (mode === "leftovers") {
      // Read-only: every rehearsal stage's State by kind, lanes by number and four-digit stages by
      // ordinal, and for a whole stage what the provider says bills while it stands. Which stage
      // each ordinal is, and every recorded id, go to private output only.
      const config = stageEnvironment(subject, source);
      const phases: Record<string, number> = {};
      privateOnly.phasesMs = phases;
      const stages = await timed(phases, "listing", () =>
        readNumberedRehearsalStages(config.stage, { environment: config.deploy, lanes: true }),
      );
      await writeFile(
        join(outputs, "rehearsal-stages.json"),
        `${JSON.stringify(stages, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      const { stageReads } = await import("./stage-table-reads.ts");
      const { stageTable } = await import("./stage-table.ts");
      const lines = await stageTable(stages, stageReads(config.deploy));
      console.log(`Rehearsal stages State still lists: ${stages.length}.`);
      for (const line of lines) console.log(line);
      result.stages = lines;
      // The retire's own proof for every four-digit stage, by the ordinal retire gives it. Only
      // reads: no plan, no destroy, no State write.
      console.log("What a retire would take, by its own proof:");
      result.retireProof = await leftoversProof(
        stages
          .filter(({ stage }) => !/^test-rehearsal-[1-9]$/u.test(stage))
          .map(({ stage, unreadable }, index) => ({ ordinal: index + 1, stage, unreadable })),
        {
          ...retireReads(config, source),
          phases,
          log: (line) => console.log(line),
          writeRefusals: (refusals) => writeRefusals(outputs, refusals),
          keepPrivate: (text) =>
            writeFile(join(outputs, "retire-proof-error.txt"), `${text}\n`, { mode: 0o600 }),
        },
      );
    } else if (mode === "retire") {
      // One four-digit stage per run, through the lane's own destroy and absence check. The stage
      // is named by its ordinal only; which stage that is stays in private output.
      const config = stageEnvironment(subject, source);
      const phases: Record<string, number> = {};
      privateOnly.phasesMs = phases;
      const stages = await timed(phases, "listing", () =>
        readNumberedRehearsalStages(config.stage, { environment: config.deploy }),
      );
      const { lines, candidates } = retirePlan(stages);
      console.log(`Four-digit rehearsal stages State still lists: ${stages.length}.`);
      for (const line of lines) console.log(line);
      result.numberedStages = stages.length;
      result.retired = null;
      const refusals: RetireRefusal[] = [];
      const { taken } = await proveStages(candidates, {
        ...retireReads(config, source),
        refusals,
        phases,
        log: (line) => console.log(line),
        take: async (stage, stacks) => {
          const target = retireSubject(stage);
          await timed(phases, "plan", () => planStage(root, target, source));
          // The destroy reads the stage's rows again in its own process; it refuses unless they
          // are the rows proven here. Only this destroy carries the proof.
          const { provenDigests, RETIRE_PROVEN } = await import("../release/retire-proof.ts");
          process.env[RETIRE_PROVEN] = JSON.stringify(
            provenDigests(stacks, stageEnvironment(target, source).stage),
          );
          try {
            await timed(phases, "destroy", () => destroyStage(root, target, source));
          } finally {
            delete process.env[RETIRE_PROVEN];
          }
          await timed(phases, "absence check", () => verifyStageAbsent(root, target, source));
        },
      }).finally(() => writeRefusals(outputs, refusals));
      if (taken !== undefined) {
        result.retired = taken;
        result.absent = true;
      } else console.log("No four-digit stage this mode can retire; nothing deleted.");
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
      mode === "adopt"
    ) {
      // A plan measures the deployed commit only if it is that commit, built as the stage is built.
      // A fault builds nothing, so it only checks the deployed commit.
      result.deployedCommit = await requireDeployedHead(subject, source, {
        clientOnly: mode === "fault",
      });
      if (mode === "fault") await run();
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
    await writeFile(
      join(outputs, `stage-${mode}.json`),
      `${JSON.stringify({ ...result, ...privateOnly }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (source.GITHUB_STEP_SUMMARY)
      await appendFile(
        source.GITHUB_STEP_SUMMARY,
        `**${mode}** on \`${stage}\`: ${result.seconds}s${result.failed ? " (failed)" : ""}\n\n\`\`\`json\n${redactor(source)(JSON.stringify(publicRecord(result.plan ?? result.apply ?? result.readBack ?? result), null, 2)).slice(0, 60_000)}\n\`\`\`\n`,
      );
  }
  return result;
}

/** How a retire's proof reads a numbered stage and production's records: State reads only. */
function retireReads(config: ReturnType<typeof stageEnvironment>, source: NodeJS.ProcessEnv) {
  return {
    target(stage: string) {
      const target = stageEnvironment(retireSubject(stage), source);
      return {
        stage: target.stage,
        database: target.databaseName,
        read: () => alchemyPreviewStateReader({ environment: target.deploy }).read(target.stage),
      };
    },
    production: () => readProductionRecords(config.stage, { environment: config.deploy }),
  };
}

/** Every refusal's row, path and named value: private output only, never the public record. */
async function writeRefusals(outputs: string, refusals: readonly RetireRefusal[]) {
  await writeFile(join(outputs, "retire-refusals.json"), `${JSON.stringify(refusals, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * The record as it may go public (the job log and step summary). A refused or failed command's
 * own text can name hosts, ids and values, so every such field keeps only that it was there; the
 * full record stays in the private `stage-<mode>.json`.
 */
/**
 * The entry's rollback takes the secrets it may force from the job's POLICY, as release.yml sets it
 * (a path under the release tree). A rollback without a named policy gets none, so it forces nothing.
 */
export const rollbackPolicyEnv = (command: string, policy: string | null | undefined) =>
  command === "rollback" && policy ? { POLICY: `scripts/release/policies/${policy}.json` } : {};

export function publicRecord(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[deep]";
  if (Array.isArray(value)) return value.map((item) => publicRecord(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /refus|fail|unavailable|unreadable|error/iu.test(key) && typeof item === "string"
        ? `[kept privately, ${item.length} chars]`
        : publicRecord(item, depth + 1),
    ]),
  );
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
    console.log(redactor(process.env)(JSON.stringify(publicRecord(result))));
  } catch (error) {
    // A thrown error can carry a refused command's own text; only its first line goes public,
    // capped, and the whole of it stays in the private output.
    const redact = redactor(process.env);
    const full = describeError(error, redact);
    const directory = resolve(process.env.BASALT_STAGE_OUTPUT_DIR ?? join(root, ".local/stage"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "stage-error.txt"), `${full}\n`, { mode: 0o600 }).catch(
      () => {},
    );
    console.error(
      `${(full.split("\n")[0] ?? "").slice(0, 200)} (the full error is in the private output)`,
    );
    process.exitCode = 1;
  }
}
