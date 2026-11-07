import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { State } from "alchemy/State/State";
import { evalStack } from "alchemy/Stack";
import { Cause, Context, Effect, Exit } from "effect";
import { recoverStack } from "./recover-stack.ts";
import { readRecoveryManifest } from "./recovery.ts";
import { deployStack } from "./deploy-stack.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { releaseEvidence } from "./evidence.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import { readRecoveryProgress } from "./recovery-manifest.ts";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  !/^[a-f0-9]{40}$/.test(process.env.BASALT_RELEASE_CANDIDATE ?? "")
)
  throw new Error("Release barrier requires GitHub Actions and an immutable candidate");
if (process.env.ALCHEMY_STAGE !== "production")
  throw new Error("Release barrier requires the production stage");
const args = process.argv.slice(2);
if (args.length && (args.length !== 3 || args[0] !== "--recover"))
  throw new Error("Use --recover <manifest.json> <receipt.json>");
const recoveryDirectory = args.length ? dirname(resolve(args[1]!)) : undefined;
const recovery = args.length
  ? {
      manifest: JSON.parse(await readFile(resolve(args[1]!), "utf8")),
      receipt: JSON.parse(await readFile(resolve(args[2]!), "utf8")),
    }
  : undefined;
const containerRecovery =
  recovery && "containers" in readRecoveryManifest(recovery.manifest)
    ? {
        frozen: openRecovery(
          JSON.parse(
            await readFile(resolve(recoveryDirectory!, "container-recovery.sealed.json"), "utf8"),
          ),
          process.env.EXECUTOR_ENCRYPTION_KEY ?? "",
          readRecoveryManifest(recovery.manifest).candidate,
          digest(canonical(readRecoveryManifest(recovery.manifest))),
        ),
        databaseCompatible: process.env.BASALT_RECOVERY_DATABASE_COMPATIBLE === "true",
        previous: await readFile(resolve(recoveryDirectory!, "recovery.json"), "utf8").then(
          (value) => readRecoveryProgress(JSON.parse(value)),
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw new BarrierRefusal("container-recovery-progress-unreadable");
          },
        ),
      }
    : undefined;
if (
  recovery &&
  readRecoveryManifest(recovery.manifest).candidate !== process.env.BASALT_RELEASE_CANDIDATE
)
  throw new Error("Recovery candidate does not match its frozen manifest");
process.chdir(fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url)));
const directory =
  recoveryDirectory ?? fileURLToPath(new URL("../../.local/release-barrier/", import.meta.url));
const evidence = releaseEvidence(
  directory,
  process.env.BASALT_RELEASE_CANDIDATE!,
  process.env.EXECUTOR_ENCRYPTION_KEY,
);
const result = await Effect.runPromiseExit(
  Effect.suspend(() =>
    Effect.promise(
      async () => (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default,
    ),
  ).pipe(
    Effect.flatMap((stack) =>
      evalStack(
        stack,
        (compiled) =>
          (recovery
            ? recoverStack(
                compiled,
                recovery.manifest,
                recovery.receipt,
                (value) => evidence.recovery(value),
                containerRecovery,
              )
            : deployStack(compiled, {
                candidate: process.env.BASALT_RELEASE_CANDIDATE!,
                record: evidence.record,
                publication: evidence.publication,
                manifest: evidence.manifest,
              })
          ).pipe(
            Effect.provideContext(compiled.services),
            Effect.provideService(State, Context.get(compiled.services, State)),
          ),
        { stage: "production" },
      ),
    ),
    withReleaseRuntime,
  ),
);
if (Exit.isFailure(result)) {
  const error = Cause.squash(result.cause);
  const failure = await evidence.failure(error);
  console.error(
    `Release barrier refused: ${failure.reason}${failure.worker ? ` (${failure.worker})` : ""}. See release-barrier receipts.`,
  );
  process.exitCode = 1;
}
