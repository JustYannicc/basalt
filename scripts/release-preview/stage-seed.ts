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
import { manifestPath } from "./checkpoint.ts";
import { rehearsalReleaseEnvironment } from "./rehearsal-environment.ts";
import { seedRehearsalPools } from "./rehearsal-seed.ts";
import { readPreviewManifest } from "../preview/manifest.ts";
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

export async function seedAndAdopt(input: {
  root: string;
  subject: StageSubject;
  source: NodeJS.ProcessEnv;
  outputs: string;
  deployedCommit: string;
  /** The pin's build input; the adopt refuses when the root's differs. */
  expectedInput?: string;
}) {
  const { root, subject, source, outputs } = input;
  const { stage } = stageNames(subject);
  const manifest = await readPreviewManifest(manifestPath(root, subject), subject);
  if (
    manifest.phase !== "seeded" ||
    typeof manifest.organizationId !== "string" ||
    typeof manifest.poolAppId !== "string"
  )
    throw new Error("The stage's baseline did not seed its app context");
  const seed = await seedRehearsalPools({
    infraOnly: true,
    origin: manifest.origin,
    email: source.PREVIEW_SMOKE_EMAIL ?? "",
    password: source.PREVIEW_SMOKE_PASSWORD ?? "",
    organizationId: manifest.organizationId,
    poolAppId: manifest.poolAppId,
    accounts: [],
  });
  const emptyPools = [manifest.poolAppId, ...seed.emptyPools];
  await applyRehearsalFixture(subject, lifecycleEnvironment(source, "cleanup"), {
    organization: manifest.organizationId,
    pools: emptyPools,
  });
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
        ...(input.expectedInput ? { STAGE_ADOPT_EXPECTED_INPUT: input.expectedInput } : {}),
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
  return { cleanPool: seed.cleanPool, emptyPools: emptyPools.length, adopted };
}
