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
import { deployStage, destroyStage, planStage, verifyStageAbsent } from "../preview/lifecycle.ts";
import { parseSubjectArgument, stageNames, type StageSubject } from "../preview/subject.ts";
import { describeError, redactor } from "./redact.ts";
import { manifestPath } from "./checkpoint.ts";
import { sealManifest } from "./manifest.ts";
import { nativeHooks } from "./rehearsal-native-hooks.ts";
import { planHighlights, requireBaselineShape, requireCutoverShape } from "./rehearsal-native.ts";

export const stageModes = ["check", "baseline", "plan", "apply", "destroy"] as const;
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
  command: "plan" | "deploy",
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
  outputs: string,
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
        "--include",
        "PoolWorker",
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
  const record = JSON.parse(
    await readFile(join(root, ".local/release", `${command}.json`), "utf8"),
  ) as unknown;
  return { record, highlights: planHighlights(redact(text)) };
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
    await deployStage(root, subject, { ...source, ...declaration.baseline });
    const read = await hooks.readBack("baseline");
    requireBaselineShape(read);
    result.readBack = read;
  } else if (mode === "plan") {
    result.plan = await runEntry("plan", subject, source, declaration.cutover, outputs);
  } else if (mode === "apply") {
    result.before = await hooks.readBack("before-apply");
    result.apply = await runEntry("deploy", subject, source, declaration.cutover, outputs);
    const after = await hooks.readBack("cutover");
    requireCutoverShape(after);
    result.after = after;
    result.replan = await runEntry("plan", subject, source, declaration.cutover, outputs);
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

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "seal-output") {
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
