/**
 * A standing stage's first selection, the way production got its own: an infra-only seed of the
 * pools (one account-less clean pool and the empty ones, as the rehearsal seeds them), then the
 * release client's own `adopt()` in a child (`stage-adopt.ts`), which sends signed handoff calls only.
 * Nothing here plans or applies; the stage's root must already be the one the heal proof needs.
 */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lifecycleEnvironment } from "./credentials.ts";
import { rehearsalReleaseEnvironment } from "./rehearsal-environment.ts";
import {
  rehearsalEmptyPoolCount,
  rehearsalPoolName,
  seedRehearsalPools,
} from "./rehearsal-seed.ts";
import { discoverStagePool } from "./stage-model.ts";
import { previewStageOrigin } from "../environment.ts";
import { applyRehearsalFixture } from "../preview/lifecycle.ts";
import { stageNames, type StageSubject } from "../preview/subject.ts";

const writerInputs = [
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "GITHUB_JOB",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
] as const;

const seededNames = new Set(
  Array.from({ length: rehearsalEmptyPoolCount + 1 }, (_, index) => rehearsalPoolName(index)),
);

/** How many of the apps carry a name the rehearsal seed gives the pools it creates. */
export function existingRehearsalPools(appNames: readonly string[]) {
  return appNames.filter((name) => seededNames.has(name)).length;
}

/**
 * The pool set an earlier seed left, by the names it gives: exactly one of each name, or nothing.
 * The empty pools include the smoke pool, as the rehearsal's fixture marks it.
 */
export function earlierSeed(apps: readonly { id: string; name: string }[], smokePool: string) {
  const named = apps.filter((app) => seededNames.has(app.name));
  if (named.length === 0) return undefined;
  const names = new Set(named.map((app) => app.name));
  if (named.length !== seededNames.size || names.size !== seededNames.size)
    throw new Error(
      `The stage holds ${named.length} rehearsal pools (a full seed is ${seededNames.size}, one of each name); nothing was seeded or adopted`,
    );
  const clean = named.find((app) => app.name === rehearsalPoolName(0))!;
  return {
    cleanPool: clean.id,
    emptyPools: [smokePool, ...named.filter((app) => app !== clean).map((app) => app.id)],
  };
}

export async function seedAndAdopt(input: {
  root: string;
  subject: StageSubject;
  source: NodeJS.ProcessEnv;
  outputs: string;
  deployedCommit: string;
  /** The lane's pin; the adopt refuses unless the root's image and input are exactly these. */
  pin: { image: string; input: string };
  /** The pool controller's policy count from its signed inspect, read just before. */
  controllerPolicies: number;
}) {
  const { subject, source } = input;
  const { stage, slug } = stageNames(subject);
  // A standing stage's baseline seeds its smoke organization and pool through the entry; they are
  // found as the smoke user sees them, the way the stage's model request finds them.
  const origin = previewStageOrigin(slug, source.TEST_STAGE_DOMAIN ?? "");
  const email = source.PREVIEW_SMOKE_EMAIL ?? "";
  const password = source.PREVIEW_SMOKE_PASSWORD ?? "";
  const { organizationId, poolAppId, apps } = await discoverStagePool({
    origin,
    stage,
    email,
    password,
  });
  // A full earlier seed retries only the adopt; a partial one refuses rather than seed over it.
  const earlier = earlierSeed(apps, poolAppId);
  if (earlier)
    return {
      existingPools: seededNames.size,
      seeded: "earlier",
      adopted: await adopt(input, stage, earlier),
    };
  const seed = await seedRehearsalPools({
    infraOnly: true,
    // The pool app is not asked: the controller's own record proves the stage holds no pool.
    controllerPolicies: input.controllerPolicies,
    origin,
    email,
    password,
    organizationId,
    poolAppId,
    accounts: [],
  });
  const pools = { cleanPool: seed.cleanPool, emptyPools: [poolAppId, ...seed.emptyPools] };
  await applyRehearsalFixture(subject, lifecycleEnvironment(source, "cleanup"), {
    organization: organizationId,
    pools: pools.emptyPools,
  });
  return {
    existingPools: 0,
    cleanPool: seed.cleanPool,
    emptyPools: pools.emptyPools.length,
    adopted: await adopt(input, stage, pools),
  };
}

/**
 * An adopt with no seed: nothing goes to the pool app or the host's routes. The controller's own
 * signed inspect must show no policy, here and again inside the adopt before anything is sent.
 */
export async function adoptWithoutSeed(input: {
  root: string;
  subject: StageSubject;
  source: NodeJS.ProcessEnv;
  outputs: string;
  deployedCommit: string;
  pin: { image: string; input: string };
  controllerPolicies: number;
  /** What the release entry evaluates this stage's stack with: the fleet declaration and the pin. */
  stackEnv: NodeJS.ProcessEnv;
}) {
  if (input.controllerPolicies !== 0)
    throw new Error(
      `The pool controller holds ${input.controllerPolicies} policies; an adopt with no seed needs none`,
    );
  return { seeded: "none", adopted: await adopt(input, stageNames(input.subject).stage, "none") };
}

async function adopt(
  input: {
    root: string;
    source: NodeJS.ProcessEnv;
    outputs: string;
    deployedCommit: string;
    pin: { image: string; input: string };
    stackEnv?: NodeJS.ProcessEnv;
  },
  stage: string,
  pools: "none" | { cleanPool: string; emptyPools: readonly string[] },
) {
  const { root, source, outputs } = input;
  const writer: NodeJS.ProcessEnv = {
    ...lifecycleEnvironment(source, "deploy"),
    ALCHEMY_STAGE: stage,
    BASALT_RELEASE_CANDIDATE: input.deployedCommit,
  };
  for (const name of writerInputs) if (source[name]) writer[name] = source[name];
  const out = join(outputs, "adopt.json");
  const log = join(outputs, "adopt.log");
  const code = await new Promise<number | null>((done) => {
    // Bun, as the release entry runs the same stack: plain node cannot load its TypeScript.
    const child = spawn("bun", [join(root, "scripts/release-preview/stage-adopt.ts"), out], {
      cwd: root,
      env: {
        ...rehearsalReleaseEnvironment(writer),
        // As runEntry gives the entry: the same stack evaluates the same as the deployed one.
        ...input.stackEnv,
        PREVIEW_AUTH_SEED_OUTPUT: join(outputs, `seed-adopt-${Date.now()}.json`),
        BASALT_STAGE_OUTPUT_DIR: outputs,
        PATH: source.PATH,
        HOME: source.HOME,
        STAGE_ADOPT_EXPECTED_IMAGE: input.pin.image,
        STAGE_ADOPT_EXPECTED_INPUT: input.pin.input,
        // The policies the controller must hold before anything is sent.
        ...(pools === "none"
          ? { STAGE_ADOPT_POLICIES: "none" }
          : {
              STAGE_ADOPT_CLEAN_POOL: pools.cleanPool,
              STAGE_ADOPT_EMPTY_POOLS: JSON.stringify(pools.emptyPools),
            }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("close", async (status) => {
      await writeFile(log, Buffer.concat(chunks), { mode: 0o600 }).catch(() => {});
      done(status);
    });
  });
  const adopted = JSON.parse(await readFile(out, "utf8").catch(() => "null")) as Record<
    string,
    unknown
  > | null;
  if (code !== 0 || !adopted)
    throw new Error(`The adopt exited ${code}; its private log is adopt.log`);
  return adopted;
}
