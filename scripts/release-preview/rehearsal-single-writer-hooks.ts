import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StageSubject } from "../preview/subject.ts";
import { planStageVariant, redeployStage, withStageBuild } from "../preview/lifecycle.ts";
import type { RehearsalHooks } from "./rehearsal-plan.ts";
import type { RecoveryHooks } from "./rehearsal-recovery.ts";
import type { SingleWriterHooks, SourceEdit } from "./rehearsal-single-writer.ts";
import type { ShapePhase } from "./rehearsal-worker-shape.ts";
import { rehearsalReleaseEnvironment } from "./rehearsal-environment.ts";
import { baselineProbeOutput } from "../release-barrier/baseline-probe-report.ts";

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
  /** The rehearsal writer's identity for the candidate now being released, as `deploy.ts` receives it. */
  writerEnvironment(): NodeJS.ProcessEnv;
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
  const { root, subject, privateRoot, operation, deployEnvironment, hooks } = context;
  /** The stage's own keys with that identity, for operations on the candidate. */
  const candidateEnvironment = () => rehearsalReleaseEnvironment(context.writerEnvironment());
  const shapeRecord = join(privateRoot, "worker-shape.json");
  const shape = async (phase: ShapePhase, label: string, selection = false) => {
    await operation(
      `shape-${label}`,
      root,
      "scripts/release-preview/rehearsal-worker-shape.ts",
      [phase, shapeRecord],
      {
        ...candidateEnvironment(),
        // Once a release installed its controller, its selection must hold across re-dispatches.
        REHEARSAL_CONTROLLER_CANDIDATE: selection ? context.current() : undefined,
      },
      5,
      "bun",
    );
    await mkdir(receipts(root), { recursive: true });
    await copyFile(shapeRecord, join(receipts(root), `worker-shape-${label}.json`));
  };
  const preflight = async () => {
    // Read-only against the seeded stage, in the preflight's rehearsal context for this candidate.
    await rm(join(root, ".local", "release-preflight", "report.json"), { force: true });
    await operation(
      "preflight",
      root,
      "scripts/release-barrier/release-preflight-entry.ts",
      [],
      {
        ...candidateEnvironment(),
        GITHUB_EVENT_NAME: undefined,
        GITHUB_EVENT_PATH: undefined,
      },
      10,
      "bun",
    ).catch(() => {});
    const report = await readFile(join(root, ".local", "release-preflight", "report.json"), "utf8");
    await keep(root, `preflight-report-${context.current().slice(0, 12)}.json`, report);
    return JSON.parse(report) as unknown;
  };
  const baselineProbe = async (edit?: SourceEdit) => {
    // Release-main's read before its backup: the candidate's entry, with the stage's brand in place
    // so its zone read is the stage's. It derives the stage's environment itself, as deploy.ts does.
    const output = join(root, baselineProbeOutput);
    await rm(output, { force: true });
    let exit: unknown;
    const path = edit && join(root, edit.path);
    const original = path && (await readFile(path, "utf8"));
    if (edit && original!.split(edit.from).length !== 2)
      throw new Error("The baseline probe's source seam changed");
    await withStageBuild(
      root,
      subject,
      deployEnvironment,
      async () => {
        if (edit) await writeFile(path!, original!.replace(edit.from, edit.to));
        try {
          // A refused row also exits non-zero; the rows say why, so only a missing report is fatal here.
          await operation(
            edit ? "baseline-probe-variant" : "baseline-probe",
            root,
            "scripts/release-preview/rehearsal-baseline-probe.ts",
            [],
            {
              ...context.writerEnvironment(),
              BASALT_RELEASE_ATTEMPT: randomUUID(),
              // Evaluating a disposable stage's stack reads the seed output path, as its release does.
              PREVIEW_AUTH_SEED_OUTPUT: join(privateRoot, `seed-probe-${randomUUID()}.json`),
            },
            5,
            "bun",
          ).catch((error: unknown) => {
            exit = error;
          });
        } finally {
          if (edit) await writeFile(path!, original!);
        }
      },
      undefined,
      { build: false },
    );
    const rows = await readFile(output, "utf8").catch(() => {
      throw new Error(`The baseline probe wrote no report: ${String(exit ?? "it exited cleanly")}`);
    });
    await keep(
      root,
      `baseline-probe-${edit ? "undeclared-class-" : ""}${context.current().slice(0, 12)}.json`,
      rows,
    );
    return JSON.parse(rows) as unknown;
  };
  /** Runs the release barrier's entry for the current candidate with the stage's brand in place. */
  const entry = async (label: string, args: string[]) => {
    await rm(join(receipts(root), "failure.json"), { force: true });
    let exited = true;
    await withStageBuild(
      root,
      subject,
      deployEnvironment,
      async () => {
        await operation(
          label,
          root,
          "scripts/release-barrier/entry.ts",
          args,
          {
            ...candidateEnvironment(),
            PREVIEW_AUTH_SEED_OUTPUT: join(privateRoot, `seed-${label}.json`),
          },
          30,
          "bun",
        ).catch(() => {
          exited = false;
        });
      },
      undefined,
      { build: false },
    );
    return exited;
  };

  const forward: SingleWriterHooks = {
    deployBaseline: hooks.deployBaseline,
    seedPools: hooks.seedPools,
    release: hooks.release,
    serve: hooks.serve,
    shape: (phase, label) => shape(phase, label),
    baselineProbe,
    preflight,
    // The single-writer change binds both fleet classes always; dropping that must show the hazard.
    planWithoutFleetBindings: () =>
      planStageVariant(root, subject, deployEnvironment, {
        path: "src/pool/deployment.ts",
        from: "...fleetBindings(fleet),",
        to: "...fleet,",
      }),
    redeploy: (change) =>
      redeployStage(
        root,
        subject,
        deployEnvironment,
        change ? { POOL_CLAUDE_QUOTA_DIAGNOSTIC: "true" } : {},
      ),
  };

  const recovery: RecoveryHooks = {
    deployBaseline: hooks.deployBaseline,
    seedPools: hooks.seedPools,
    serve: hooks.serve,
    shape,
    baselineProbe,
    preflight,
    release: ({ cleanPool, stop, commit }) =>
      hooks.release({ candidate: "candidate", cleanPool, stop, commit }),
    abort: async () => {
      // The documented abort: plan, then apply exactly the planned digest. Each call writes a fresh receipt.
      const receipt = join(receipts(root), "runtime-abort.json");
      await rm(receipt, { force: true });
      if (!(await entry("abort-plan", ["--abort-runtime", "plan"])))
        throw new Error("The runtime abort plan failed");
      const planned = JSON.parse(await readFile(receipt, "utf8")) as {
        fingerprint?: unknown;
        candidate?: unknown;
      };
      if (planned.candidate !== context.current())
        throw new Error("The runtime abort plan names another candidate");
      if (typeof planned.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(planned.fingerprint))
        throw new Error("The runtime abort plan has no digest");
      await keep(root, "runtime-abort-plan.json", JSON.stringify(planned));
      await rm(receipt, { force: true });
      await entry("abort-apply", ["--abort-runtime", planned.fingerprint]);
      const applied = await readFile(receipt, "utf8");
      await keep(root, "runtime-abort-apply.json", applied);
      return JSON.parse(applied) as { status?: unknown };
    },
    nextCandidate: async () => {
      // A new, empty rehearsal commit: a different candidate with the same tree.
      if (
        execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd: root,
          encoding: "utf8",
        }).trim()
      )
        throw new Error(
          "The candidate checkout has changes; the next candidate must have the same tree",
        );
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Release rehearsal",
          "-c",
          "user.email=release-rehearsal@users.noreply.github.com",
          "commit",
          "-q",
          "--allow-empty",
          "--no-verify",
          "-m",
          "rehearsal: next candidate",
        ],
        { cwd: root },
      );
      const next = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      await operation(
        "next-prepare",
        root,
        "run",
        ["prepare:upstream"],
        deployEnvironment,
        30,
        "npm",
      );
      context.advance(next);
      return next;
    },
    recover: async ({ databaseCompatible }) => {
      // Recorded-version recovery with this run's own last pair, the way production's deploy runs it.
      const directory = receipts(root);
      for (const name of ["manifest.json", "receipt.json"])
        await readFile(join(directory, name)).catch(() => {
          throw new Error(`The stopped release left no ${name} to recover with`);
        });
      await rm(join(directory, "failure.json"), { force: true });
      let exited = true;
      await withStageBuild(
        root,
        subject,
        deployEnvironment,
        async () => {
          await operation(
            "recover",
            root,
            "scripts/deploy.ts",
            ["--recover", join(directory, "manifest.json"), join(directory, "receipt.json")],
            {
              ...candidateEnvironment(),
              // Stated, not inferred: true only when the recovered and current trees share a database.
              BASALT_RECOVERY_DATABASE_COMPATIBLE: String(databaseCompatible),
              PREVIEW_AUTH_SEED_OUTPUT: join(privateRoot, `seed-recover-${Date.now()}.json`),
            },
            60,
          ).catch(() => {
            exited = false;
          });
        },
        undefined,
        { build: false },
      );
      const failure = await readFile(join(directory, "failure.json"), "utf8").then(
        (text) => JSON.parse(text) as { reason?: unknown; worker?: unknown },
        () => undefined,
      );
      if (failure) {
        if (typeof failure.reason !== "string")
          throw new Error("The recovery failed without a recorded refusal");
        return {
          ok: false,
          reason: failure.reason,
          ...(typeof failure.worker === "string" ? { worker: failure.worker } : {}),
        };
      }
      if (!exited) throw new Error("The recovery ended without a recorded refusal");
      return { ok: true };
    },
  };
  return { forward, recovery };
}
