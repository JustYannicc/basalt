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

/** The pin the adopt runs against; without both values nothing is adopted. */
export function requiredPin(env: NodeJS.ProcessEnv) {
  const image = env.STAGE_ADOPT_EXPECTED_IMAGE ?? "";
  const input = env.STAGE_ADOPT_EXPECTED_INPUT ?? "";
  if (!/@sha256:[a-f0-9]{64}$/u.test(image) || !/^[a-f0-9]{16}$/u.test(input))
    throw new Error("Adopt needs the lane's pinned image (by digest) and its 16-hex input");
  return { image, input };
}

/**
 * The root the adopt would fix in the selection must be the pinned one, image and input: the
 * digest becomes the selected target's `imageDigest`, and every later restart compares it with
 * the platform, so a wrong one leaves a pool recovery can never restart.
 */
export function rootMatchesPin(
  root: { image: string | undefined; input: string | undefined },
  pin: { image: string; input: string },
) {
  if (root.input !== pin.input)
    throw new Error("The root's image input differs from the pin's; nothing was adopted");
  if (root.image !== pin.image)
    throw new Error("The root's image differs from the pinned digest; nothing was adopted");
}

/**
 * The selection proof adopt() signs embeds the policy digest and revisions; a retry passes only
 * with the identical manifest. So adopt only once two reads a pass apart agree.
 */
export function settledProof(first: unknown, second: unknown) {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const proof = (inspect: unknown) => {
    const view = record(inspect);
    const policies = Array.isArray(view.policies) ? view.policies : [];
    return JSON.stringify({
      digest: view.digest ?? null,
      revisions: policies
        .map((policy) => [record(policy).pool ?? null, record(policy).revision ?? null])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    });
  };
  const a = proof(first);
  if (a !== proof(second))
    throw new Error("The pools' policies were still changing; nothing was adopted");
  return JSON.parse(a) as { digest: unknown; revisions: unknown[] };
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
  const pin = requiredPin(env);
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
          rootMatchesPin(
            {
              image: state.applications.root.attributes.configuration?.image,
              input,
            },
            pin,
          );
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
          const first = yield* Effect.promise(() => client.inspect());
          // A recovery pass and the membership refresh run every few seconds; wait past one.
          yield* Effect.promise(() => new Promise((done) => setTimeout(done, 10_000)));
          const second = yield* Effect.promise(() => client.inspect());
          const proof = settledProof(first, second);
          const before = adoptedState(second, false);
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
          return { stage, candidate: writer.candidate, proof, rootInput: input, before, after };
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
