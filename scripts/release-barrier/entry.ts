import { assertReleaseStateVersion } from "./release-state-version.ts";
import { homeSchemaRetryAuthorization } from "./home-schema-retry.ts";
import { loadDeclaredChanges } from "./declared-file.ts";
import { undoForwardAdoption } from "./forward-undo.ts";
import { releaseRuntimeImage } from "./runtime-image-release.ts";
import { abortRuntimeRelease } from "./runtime-release-abort.ts";
import { writeFile, mkdir } from "node:fs/promises";
import { ordinaryReleaseWriter } from "./runtime-release-writer.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { State } from "alchemy/State/State";
import { evalStack } from "alchemy/Stack";
import { Context, Effect } from "effect";
import { recoverStack } from "./recover-stack.ts";
import { readRecoveryManifest } from "./recovery.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { releaseEvidence } from "./evidence.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import { releaseOutcome } from "./entry-outcome.ts";
import { readRecoveryProgress } from "./recovery-manifest.ts";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  !/^[a-f0-9]{40}$/.test(process.env.BASALT_RELEASE_CANDIDATE ?? "")
)
  throw new Error("Release barrier requires GitHub Actions and an immutable candidate");
if (process.env.ALCHEMY_STAGE !== "production")
  throw new Error("Release barrier requires the production stage");
const homeSchemaRetryIntent = homeSchemaRetryAuthorization(process.env);
const args = process.argv.slice(2);
const abortMode = args[0] === "--abort-runtime" && args.length === 2 ? args[1] : undefined;
const undoPath = args[0] === "--undo-forward" && args.length === 2 ? resolve(args[1]!) : undefined;
if (args.length && !abortMode && !undoPath && (args.length !== 3 || args[0] !== "--recover"))
  throw new Error(
    "Use --recover <manifest.json> <receipt.json> or --abort-runtime <plan|inspect|plan-digest>",
  );
const recoveryDirectory = args[0] === "--recover" ? dirname(resolve(args[1]!)) : undefined;
const recovery =
  args[0] === "--recover"
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
process.exitCode = await releaseOutcome(evidence, process.env.GITHUB_STEP_SUMMARY, async () => {
  await evidence.desired(
    JSON.parse(
      await readFile(new URL("../../containers/pool/releases.json", import.meta.url), "utf8"),
    ),
  );
  return await Effect.runPromiseExit(
    Effect.suspend(() =>
      Effect.promise(
        async () => (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default,
      ),
    ).pipe(
      Effect.flatMap((stack) =>
        undoPath || recovery || abortMode
          ? evalStack(
              stack,
              (compiled) =>
                Effect.gen(function* () {
                  if (abortMode) {
                    const receipt = yield* abortRuntimeRelease(
                      compiled,
                      ordinaryReleaseWriter(process.env),
                      abortMode,
                    );
                    yield* Effect.promise(async () => {
                      await mkdir(directory, { recursive: true });
                      await writeFile(
                        resolve(directory, "runtime-abort.json"),
                        JSON.stringify(receipt, null, 2) + "\n",
                        { mode: 0o600 },
                      );
                      if (process.env.GITHUB_STEP_SUMMARY) {
                        const { appendFile } = await import("node:fs/promises");
                        await appendFile(
                          process.env.GITHUB_STEP_SUMMARY,
                          `Runtime startup abort ${receipt.status}. Plan digest: ${receipt.fingerprint}.\n`,
                        );
                      }
                    });
                  } else if (undoPath) yield* undoForwardAdoption(compiled, undoPath);
                  else
                    yield* recoverStack(
                      compiled,
                      recovery!.manifest,
                      recovery!.receipt,
                      (value) => evidence.recovery(value),
                      containerRecovery,
                    );
                }).pipe(
                  (effect) => assertReleaseStateVersion(compiled).pipe(Effect.andThen(effect)),
                  Effect.provideContext(compiled.services),
                  Effect.provideService(State, Context.get(compiled.services, State)),
                ),
              { stage: "production" },
            )
          : Effect.gen(function* () {
              const declarations = yield* Effect.tryPromise({
                try: () => loadDeclaredChanges(fileURLToPath(new URL("../../", import.meta.url))),
                catch: (error) => error,
              });
              return yield* releaseRuntimeImage(stack, {
                candidate: process.env.BASALT_RELEASE_CANDIDATE!,
                writer: ordinaryReleaseWriter(process.env),
                directory,
                encryptionKey: process.env.EXECUTOR_ENCRYPTION_KEY ?? "",
                declarations,
                declared: evidence.declared,
                declaredReadiness: evidence.declaredReadiness,
                expansion: evidence.expansion,
                forwardEncryptionKey: process.env.EXECUTOR_ENCRYPTION_KEY,
                homeSchemaRetryIntent,
                record: evidence.record,
                publication: evidence.publication,
                admission: evidence.admission,
                namespaceRead: evidence.namespaceRead,
                bucketRead: evidence.bucketRead,
                serving: evidence.serving,
                manifest: evidence.manifest,
              });
            }),
      ),
      withReleaseRuntime,
    ),
  );
});
