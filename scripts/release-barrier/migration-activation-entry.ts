import { evalStack } from "alchemy/Stack";
import { Cause, Effect, Exit } from "effect";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { migrationActivationGate } from "./migration-activation-gate.ts";
import { migrationActivationPorts } from "./migration-activation-runtime.ts";
import { runMigrationActivation } from "./migration-activation.ts";
import { BarrierRefusal } from "./manifest.ts";
import { assertReleaseStateVersion } from "./release-state-version.ts";
import { reportRefusal } from "./refusal-report.ts";
import { readOnlyFailure } from "./read-only-failure.ts";
import { releaseEvidence } from "./evidence.ts";
import { withReleaseRuntime } from "./runtime.ts";

const directory = fileURLToPath(new URL("../../.local/release-barrier/", import.meta.url));
const output = `${directory}/migration-activation.json`;
const summary = process.env.GITHUB_STEP_SUMMARY;

try {
  const gate = await migrationActivationGate();
  if (process.env.ALCHEMY_STAGE !== "production")
    throw new BarrierRefusal("migration-activation-production-stage-required");
  process.chdir(fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url)));
  const result = await Effect.runPromiseExit(
    Effect.promise(
      async () => (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default,
    ).pipe(
      Effect.flatMap((stack) =>
        evalStack(
          stack,
          (compiled) =>
            Effect.gen(function* () {
              yield* assertReleaseStateVersion(compiled);
              const ports = yield* migrationActivationPorts({
                stack: compiled,
                candidate: gate.candidate,
                deploymentId: gate.deploymentId,
              });
              return yield* Effect.tryPromise({
                try: () => runMigrationActivation({ ...gate, ports }),
                catch: (error) => error,
              });
            }).pipe(Effect.provideContext(compiled.services)),
          { stage: "production" },
        ),
      ),
      withReleaseRuntime,
    ),
  );
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  const receipt = result.value;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  const message = `Migration activation ${receipt.status} for ${receipt.candidate}. Plan digest: ${receipt.fingerprint}. Targets: hosted 22, model-history v10.`;
  console.log(message);
  if (summary) await appendFile(summary, `${message}\n\n`);
  if (gate.mode !== "plan" && gate.mode !== "inspect" && receipt.status !== "complete") {
    if (summary)
      await appendFile(
        summary,
        "Activation outcome is pending. Use migration_activation=inspect. No activation will be resent.\n\n",
      );
    process.exitCode = 1;
  }
} catch (error) {
  const failure = await releaseEvidence(
    directory,
    /^[a-f0-9]{40}$/u.test(process.env.BASALT_RELEASE_CANDIDATE ?? "")
      ? process.env.BASALT_RELEASE_CANDIDATE!
      : "unknown",
  ).failure(readOnlyFailure(error, []));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify({ status: "refused", ...failure }, null, 2) + "\n", {
    mode: 0o600,
  });
  await reportRefusal(failure, summary);
  process.exitCode = 1;
}
