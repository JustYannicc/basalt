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
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageEnvironment } from "../environment.ts";
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
import { manifestPath } from "./checkpoint.ts";
import { sealManifest } from "./manifest.ts";
import { nativeHooks } from "./rehearsal-native-hooks.ts";
import { planHighlights, requireBaselineShape, requireCutoverShape } from "./rehearsal-native.ts";

export const stageModes = [
  "check",
  "baseline",
  "plan",
  "apply",
  "code",
  "settle",
  "destroy",
] as const;
export type StageMode = (typeof stageModes)[number];

/** The pull-request label that dispatches a mode: `stage-<mode>` on lane 1, `stage-<mode>-<lane>` on 2 or 3. */
export function stageLabel(label: string): { mode: StageMode; lane: number } | undefined {
  const match = /^stage-([a-z]+)(?:-([1-3]))?$/u.exec(label);
  const mode = stageModes.find((name) => name === match?.[1]);
  return mode ? { mode, lane: Number(match?.[2] ?? "1") } : undefined;
}

/** A lane's stage stands across runs; its keys derive from the state key, so every job re-plans it. */
export const laneSubject = (lane: number): StageSubject => {
  if (![1, 2, 3].includes(lane)) throw new Error("A standing stage lane is 1, 2 or 3");
  return parseSubjectArgument(`rehearsal-${lane}`);
};

/** The fleet declaration each mode deploys: production's today, or the cutover's. */
export const declaration = {
  baseline: { POOL_FLEET_CLASSES: "absent" },
  cutover: { POOL_FLEET_CLASSES: "declared", POOL_FLEET_BUILD: "true" },
} as const;

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = join(root, "scripts/release/deploy.ts");
const cloud = join(root, ".upstream/apps/hosted/cloud");

async function runEntry(
  command: "plan" | "deploy" | "serving" | "rollback",
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  outputs: string,
  {
    policy = "cutover-classes",
    args = [],
  }: { policy?: string | null; args?: readonly string[] } = {},
) {
  if (!existsSync(entry))
    throw new Error("The release entry is not in this tree; nothing applies without it");
  const config = stageEnvironment(subject, source);
  const seed = join(outputs, `seed-${command}-${Date.now()}.json`);
  const log = join(outputs, `entry-${command}-${Date.now()}.log`);
  await rm(join(root, ".local/release", `${command}.json`), { force: true });
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
          ? ["--policy", join(root, `scripts/release/policies/${policy}.json`)]
          : []),
        // Without a policy, the cutover's include still scopes the plan to PoolWorker and its inputs.
        ...((command === "plan" || command === "deploy") && !policy
          ? ["--include", "PoolWorker"]
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
    const lines = text
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !/^\s+at .*(?:\(|file:|node:|<anonymous>)/u.test(line))
      .slice(-150);
    throw new Error(
      `The release entry's ${command} failed with exit ${code}:\n${redact(lines.join("\n"))}`,
    );
  }
  const record = (
    command === "plan" || command === "deploy"
      ? JSON.parse(await readFile(join(root, ".local/release", `${command}.json`), "utf8"))
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
      const line = stdout.trim().split("\n").pop() ?? "";
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { unavailable: redactor(source)(stderr.split("\n").slice(-20).join("\n")) };
      }
    },
  };
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
  const result: Record<string, unknown> = { mode, lane, stage };
  // Each job re-plans the stage's manifest unless the workflow already did; identity derives from the state key.
  if (!existsSync(manifestPath(root, subject))) await planStage(root, subject, source);
  if (mode === "baseline") {
    await budgetProbe(subject, source, outputs);
    const env: NodeJS.ProcessEnv = { ...source, ...declaration.baseline };
    try {
      await deployStage(root, subject, env);
    } catch (error) {
      // An existing stage: deploy it again with the root pinned, as production's root is. No policy
      // here, so the root may roll once; every later policy run then sees the pinned form.
      if (error instanceof Error && /existing remote state/u.test(error.message)) {
        // A stage whose PoolWorker never deployed has no root identity yet: deploy it unpinned first.
        const pin = await rootPin(hooks, subject, source).catch(() => undefined);
        if (pin) Object.assign(env, { POOL_ROOT_IMAGE: pin });
        result.rootPinned = Boolean(pin);
      }
      // A standing stage that already has state (a partial or earlier baseline) is deployed again
      // the ordinary way; Alchemy resumes from its state.
      if (!(error instanceof Error && /existing remote state/u.test(error.message))) throw error;
      await withStageBuild(root, subject, env, async () => {});
      await redeployStage(root, subject, env, {
        ...declaration.baseline,
        ...(env.POOL_ROOT_IMAGE ? { POOL_ROOT_IMAGE: env.POOL_ROOT_IMAGE } : {}),
      });
      result.redeployed = true;
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
      result.planRefused = redactor(source)(error instanceof Error ? error.message : String(error));
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
    const env = { ...declaration.baseline, POOL_ROOT_IMAGE: await rootPin(hooks, subject, source) };
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
      await writeFile(join(outputs, `settle-${label}.json`), `${JSON.stringify(rows, null, 2)}\n`, {
        mode: 0o600,
      });
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
  } else if (mode === "destroy") {
    await destroyStage(root, subject, source);
    await verifyStageAbsent(root, subject, source);
    result.absent = true;
  }
  result.seconds = Math.round((Date.now() - started) / 1000);
  await writeFile(join(outputs, `stage-${mode}.json`), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  if (source.GITHUB_STEP_SUMMARY)
    await appendFile(
      source.GITHUB_STEP_SUMMARY,
      `**${mode}** on \`${stage}\`: ${result.seconds}s\n\n\`\`\`json\n${redactor(source)(JSON.stringify(result.plan ?? result.apply ?? result.readBack ?? result, null, 2)).slice(0, 60_000)}\n\`\`\`\n`,
    );
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
