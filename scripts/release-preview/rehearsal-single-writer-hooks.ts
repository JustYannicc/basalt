import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StageSubject } from "../preview/subject.ts";
import { planStageVariant, redeployStage, withStageBuild } from "../preview/lifecycle.ts";
import type { RehearsalHooks } from "./rehearsal-plan.ts";
import type { RecoveryHooks } from "./rehearsal-recovery.ts";
import type { SingleWriterHooks } from "./rehearsal-single-writer.ts";
import type { ShapePhase } from "./rehearsal-worker-shape.ts";

type Operation = (
  label: string,
  directory: string,
  script: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  minutes?: number,
  command?: string,
) => Promise<void>;

/** What the single-writer scenarios need from the runner that owns the stage and its checkouts. */
export type SingleWriterContext = {
  root: string;
  subject: StageSubject;
  privateRoot: string;
  operation: Operation;
  deployEnvironment: NodeJS.ProcessEnv;
  /** The stage's keys and the rehearsal writer's identity for the candidate now being released. */
  candidateEnvironment(): NodeJS.ProcessEnv;
  /** The candidate commit now in the candidate checkout, and a way to move to the next one. */
  current(): string;
  advance(commit: string): void;
  hooks: RehearsalHooks;
};

const receipts = (root: string) => join(root, ".local", "release-barrier");

async function keep(root: string, name: string, text: string) {
  await mkdir(receipts(root), { recursive: true });
  await writeFile(join(receipts(root), name), text, { mode: 0o600 });
}

export function singleWriterHooks(context: SingleWriterContext) {
  const { root, subject, privateRoot, operation, deployEnvironment, candidateEnvironment, hooks } = context;
  const shapeRecord = join(privateRoot, "worker-shape.json");
  const shape = async (phase: ShapePhase, label: string, selection = false) => {
    await operation(`shape-${label}`, root, "scripts/release-preview/rehearsal-worker-shape.ts", [phase, shapeRecord], {
      ...candidateEnvironment(),
      // Once a release installed its controller, its selection must hold across re-dispatches.
      REHEARSAL_CONTROLLER_CANDIDATE: selection ? context.current() : undefined,
    }, 5, "bun");
    await mkdir(receipts(root), { recursive: true });
    await copyFile(shapeRecord, join(receipts(root), `worker-shape-${label}.json`));
  };
  const preflight = async () => {
    // Read-only against the seeded stage, in the preflight's rehearsal context for this candidate.
    await rm(join(root, ".local", "release-preflight", "report.json"), { force: true });
    await operation("preflight", root, "scripts/release-barrier/release-preflight-entry.ts", [], {
      ...candidateEnvironment(),
      GITHUB_EVENT_NAME: undefined,
      GITHUB_EVENT_PATH: undefined,
    }, 10, "bun").catch(() => {});
    const report = await readFile(join(root, ".local", "release-preflight", "report.json"), "utf8");
    await keep(root, `preflight-report-${context.current().slice(0, 12)}.json`, report);
    return JSON.parse(report) as unknown;
  };
  /** Runs the release barrier's entry for the current candidate with the stage's brand in place. */
  const entry = async (label: string, args: string[]) => {
    await rm(join(receipts(root), "failure.json"), { force: true });
    let exited = true;
    await withStageBuild(root, subject, deployEnvironment, async () => {
      await operation(label, root, "scripts/release-barrier/entry.ts", args, {
        ...candidateEnvironment(),
        PREVIEW_AUTH_SEED_OUTPUT: join(privateRoot, `seed-${label}.json`),
      }, 30, "bun").catch(() => { exited = false; });
    }, undefined, { build: false });
    return exited;
  };

  const forward: SingleWriterHooks = {
    deployBaseline: hooks.deployBaseline,
    seedPools: hooks.seedPools,
    release: hooks.release,
    serve: hooks.serve,
    shape: (phase, label) => shape(phase, label),
    preflight,
    // The single-writer change binds both fleet classes always; dropping that must show the hazard.
    planWithoutFleetBindings: () =>
      planStageVariant(root, subject, deployEnvironment, {
        path: "src/pool/deployment.ts",
        from: "...fleetBindings(fleet),",
        to: "...fleet,",
      }),
    redeploy: (change) =>
      redeployStage(root, subject, deployEnvironment, change ? { POOL_CLAUDE_QUOTA_DIAGNOSTIC: "true" } : {}),
  };

  const recovery: RecoveryHooks = {
    deployBaseline: hooks.deployBaseline,
    seedPools: hooks.seedPools,
    serve: hooks.serve,
    shape,
    preflight,
    release: ({ cleanPool, stop, commit }) => hooks.release({ candidate: "candidate", cleanPool, stop, commit }),
    abort: async () => {
      // The documented abort: plan, then apply exactly the planned digest.
      await entry("abort-plan", ["--abort-runtime", "plan"]);
      const planned = JSON.parse(await readFile(join(receipts(root), "runtime-abort.json"), "utf8")) as { fingerprint?: unknown };
      if (typeof planned.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(planned.fingerprint))
        throw new Error("The runtime abort plan has no digest");
      await keep(root, "runtime-abort-plan.json", JSON.stringify(planned));
      await entry("abort-apply", ["--abort-runtime", planned.fingerprint]);
      const applied = await readFile(join(receipts(root), "runtime-abort.json"), "utf8");
      await keep(root, "runtime-abort-apply.json", applied);
      return JSON.parse(applied) as { status?: unknown };
    },
    nextCandidate: async () => {
      // A new, empty rehearsal commit: a different candidate with the same tree.
      execFileSync("git", ["-c", "user.name=Release rehearsal", "-c", "user.email=release-rehearsal@users.noreply.github.com",
        "commit", "-q", "--allow-empty", "--no-verify", "-m", "rehearsal: next candidate"], { cwd: root });
      const next = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      await operation("next-prepare", root, "run", ["prepare:upstream"], deployEnvironment, 30, "npm");
      context.advance(next);
      return next;
    },
    recover: async () => {
      // Recorded-version recovery with this run's own last pair, the way production's deploy runs it.
      const directory = receipts(root);
      for (const name of ["manifest.json", "receipt.json"])
        await readFile(join(directory, name)).catch(() => {
          throw new Error(`The stopped release left no ${name} to recover with`);
        });
      await rm(join(directory, "failure.json"), { force: true });
      let exited = true;
      await withStageBuild(root, subject, deployEnvironment, async () => {
        await operation("recover", root, "scripts/deploy.ts", ["--recover", join(directory, "manifest.json"), join(directory, "receipt.json")], {
          ...candidateEnvironment(),
          PREVIEW_AUTH_SEED_OUTPUT: join(privateRoot, `seed-recover-${Date.now()}.json`),
        }, 60).catch(() => { exited = false; });
      }, undefined, { build: false });
      const failure = await readFile(join(directory, "failure.json"), "utf8").then((text) => JSON.parse(text) as { reason?: unknown; worker?: unknown }, () => undefined);
      if (failure) {
        if (typeof failure.reason !== "string") throw new Error("The recovery failed without a recorded refusal");
        return { ok: false, reason: failure.reason, ...(typeof failure.worker === "string" ? { worker: failure.worker } : {}) };
      }
      if (!exited) throw new Error("The recovery ended without a recorded refusal");
      return { ok: true };
    },
  };
  return { forward, recovery };
}
