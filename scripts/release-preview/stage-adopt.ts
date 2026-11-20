/**
 * Rehearsal-only: gives a standing stage's legacy root its first selection, the way production's
 * release did, and nothing else. It evaluates the stack (no plan, no apply) and sends only the
 * signed handoff calls of the release client's own `adopt()`: inspect, the root's health,
 * the provider observation, the `unattested-active` admission and `adopt`, with the stage's own
 * deployment key. A selection that exists is left alone (adopt() then only checks health).
 *
 * Usage (from the stage runner, with the stage's release environment):
 *   node scripts/release-preview/stage-adopt.ts <outFile>
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const rehearsalStage = /^test-rehearsal-[1-9][0-9]{0,9}$/u;

/** Refuses anything but a standing rehearsal stage whose own pool Worker is the target. */
export function adoptTarget(stage: string | undefined, workerName?: string) {
  if (!stage || !rehearsalStage.test(stage))
    throw new Error(`Adopt runs only on a test-rehearsal-<n> stage, not ${stage ?? "(unset)"}`);
  if (workerName !== undefined && !workerName.includes(`-${stage}-`))
    throw new Error("The pool Worker the adopt would address is not this stage's");
  return stage;
}

/**
 * The scope the release client writes into every manifest (`releaseScope()`): it must be a
 * rehearsal stack and stage. An unset stage reads as production there, so it refuses too.
 */
export async function adoptScope(env: NodeJS.ProcessEnv) {
  const { releaseTarget } = await import("../release-barrier/release-stage.ts");
  const target = releaseTarget(env);
  if (!target.rehearsal) throw new Error("Adopt refuses a production release scope");
  adoptTarget(target.stage);
  return { stack: target.stack, stage: target.stage };
}

/** What the heal proof needs before any fault, from the controller's own inspect and health. */
export function adoptedState(inspect: unknown, healthy: boolean) {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const selection = record(record(inspect).selection);
  const active = record(selection.active);
  const target = record(active.target);
  return {
    epoch: typeof selection.epoch === "number" ? selection.epoch : null,
    slotId: typeof target.slotId === "string" ? target.slotId : null,
    homePeerOrdinal: "homePeerOrdinal" in target,
    fenced: typeof active.fenced === "boolean" ? active.fenced : null,
    applicationVersion: target.applicationVersion ?? null,
    imageDigest: typeof target.imageDigest === "string" ? target.imageDigest : null,
    imageInput: typeof target.imageInput === "string" ? target.imageInput : null,
    healthy,
  };
}

async function main(outFile: string | undefined, env: NodeJS.ProcessEnv) {
  if (!outFile) throw new Error("Usage: stage-adopt.ts <outFile>");
  if (env.GITHUB_ACTIONS !== "true") throw new Error("Adopt runs only in GitHub Actions");
  const stage = adoptTarget(env.ALCHEMY_STAGE);
  // The manifests adopt() signs name this scope; it is read from the same environment.
  const scope = await adoptScope(env);
  if (scope.stage !== stage) throw new Error("The release scope names another stage");
  const expectedInput = env.STAGE_ADOPT_EXPECTED_INPUT;
  const [
    { evalStack },
    { State },
    { Context, Effect },
    { withReleaseRuntime },
    { assertReleaseStateVersion },
    { runtimeReleaseState },
    { runtimeReleaseClient },
    { ordinaryReleaseWriter },
    { verifyBoundProviderObservation },
    { poolWorkerRevision },
  ] = await Promise.all([
    import("alchemy/Stack"),
    import("alchemy/State/State"),
    import("effect"),
    import("../release-barrier/runtime.ts"),
    import("../release-barrier/release-state-version.ts"),
    import("../release-barrier/runtime-release-state.ts"),
    import("../release-barrier/runtime-release-client.ts"),
    import("../release-barrier/runtime-release-writer.ts"),
    import("../release-barrier/runtime-provider-observation.ts"),
    import("../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts"),
  ]);
  const directory = fileURLToPath(new URL("../../.local/stage-adopt/", import.meta.url));
  const writer = ordinaryReleaseWriter(env);
  const code = { candidate: writer.candidate, workerInput: poolWorkerRevision };
  process.chdir(fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url)));
  const stack = (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default;
  const exit = await Effect.runPromiseExit(
    evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          yield* assertReleaseStateVersion(compiled);
          const state = yield* runtimeReleaseState(compiled);
          adoptTarget(stage, state.target.worker);
          // The Worker's binding, the release state's root input and the pin agree, or nothing is sent.
          const input = state.applications.root.image.inputHash;
          if (expectedInput && input !== expectedInput)
            throw new Error("The root's image input differs from the pin's; nothing was adopted");
          let promotion: unknown;
          const client = yield* runtimeReleaseClient({
            state,
            code,
            writer,
            promotion: {
              read: async () => promotion as never,
              write: async (next) => {
                promotion = next;
              },
            },
          });
          const before = adoptedState(yield* Effect.promise(() => client.inspect()), false);
          yield* Effect.promise(() =>
            verifyBoundProviderObservation({
              state,
              code,
              client,
              directory,
              encryptionKey: env.EXECUTOR_ENCRYPTION_KEY ?? "",
            }),
          );
          yield* Effect.promise(() => client.adopt());
          const healthy = yield* Effect.promise(() =>
            client.health().then(
              () => true,
              () => false,
            ),
          );
          const after = adoptedState(yield* Effect.promise(() => client.inspect()), healthy);
          return { stage, rootInput: input, before, after };
        }).pipe(
          Effect.provideContext(compiled.services),
          Effect.provideService(State, Context.get(compiled.services, State)),
        ),
      { stage },
    ).pipe(withReleaseRuntime),
  );
  if (exit._tag === "Failure") throw new Error(`Adopt failed: ${String(exit.cause)}`);
  await writeFile(outFile, `${JSON.stringify(exit.value, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(exit.value.after)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv[2], process.env);
  } catch (error) {
    const { redactor, describeError } = await import("./redact.ts");
    process.stderr.write(`${describeError(error, redactor(process.env))}\n`);
    process.exitCode = 1;
  }
}
