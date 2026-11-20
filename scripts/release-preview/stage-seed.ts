/**
 * A standing stage's first selection, the way production got its own: an infra-only seed of the
 * pools (one account-less clean pool and the empty ones, as the rehearsal seeds them), then the
 * release client's own `adopt()` in a child (`stage-adopt.ts`), which sends signed handoff calls only.
 * Nothing here plans or applies; the stage's root must already be the one the heal proof needs.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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

/** How many of the apps carry a name the rehearsal seed gives the pools it creates. */
export function existingRehearsalPools(appNames: readonly string[]) {
  const seeded = new Set(Array.from({ length: 21 }, (_, index) => rehearsalPoolName(index)));
  return appNames.filter((name) => seeded.has(name)).length;
}

export async function seedAndAdopt(input: {
  root: string;
  subject: StageSubject;
  source: NodeJS.ProcessEnv;
  outputs: string;
  deployedCommit: string;
  /** The lane's pin; the adopt refuses unless the root's image and input are exactly these. */
  pin: { image: string; input: string };
  /** The pools already hold policies (an earlier seed): seeding again would add pools. */
  seeded: boolean;
}) {
  const { subject, source } = input;
  const { stage } = stageNames(subject);
  // A standing stage's baseline seeds its smoke organization and pool through the entry; they are
  // found as the smoke user sees them, the way the stage's model request finds them.
  const origin = previewStageOrigin(stageNames(subject).slug, source.TEST_STAGE_DOMAIN ?? "");
  const email = source.PREVIEW_SMOKE_EMAIL ?? "";
  const password = source.PREVIEW_SMOKE_PASSWORD ?? "";
  const { organizationId, poolAppId, appNames } = await discoverStagePool({
    origin,
    stage,
    email,
    password,
  });
  // Pools an earlier seed created, counted by the names the seed gives them. A full set means only
  // the adopt is retried; a partial one is refused rather than seeded over.
  const existing = existingRehearsalPools(appNames);
  if (existing > 0) {
    if (existing !== rehearsalEmptyPoolCount + 1 || !input.seeded)
      throw new Error(
        `The stage holds ${existing} rehearsal pools (a full seed is ${rehearsalEmptyPoolCount + 1}) and ${input.seeded ? "has" : "has no"} policies; nothing was seeded or adopted`,
      );
    return { existingPools: existing, seeded: "earlier", adopted: await adopt(input, stage) };
  }
  if (input.seeded)
    throw new Error(
      "The stage holds policies but no rehearsal pools; nothing was seeded or adopted",
    );
  const seed = await seedRehearsalPools({
    infraOnly: true,
    origin,
    email,
    password,
    organizationId,
    poolAppId,
    accounts: [],
  });
  const emptyPools = [poolAppId, ...seed.emptyPools];
  await applyRehearsalFixture(subject, lifecycleEnvironment(source, "cleanup"), {
    organization: organizationId,
    pools: emptyPools,
  });
  return {
    existingPools: 0,
    cleanPool: seed.cleanPool,
    emptyPools: emptyPools.length,
    adopted: await adopt(input, stage),
  };
}

async function adopt(
  input: {
    root: string;
    source: NodeJS.ProcessEnv;
    outputs: string;
    deployedCommit: string;
    pin: { image: string; input: string };
  },
  stage: string,
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
    const child = spawn("node", [join(root, "scripts/release-preview/stage-adopt.ts"), out], {
      cwd: root,
      env: {
        ...rehearsalReleaseEnvironment(writer),
        PATH: source.PATH,
        HOME: source.HOME,
        STAGE_ADOPT_EXPECTED_IMAGE: input.pin.image,
        STAGE_ADOPT_EXPECTED_INPUT: input.pin.input,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("close", async (status) => {
      const { writeFile } = await import("node:fs/promises");
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
