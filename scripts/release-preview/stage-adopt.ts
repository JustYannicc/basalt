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
import { randomUUID } from "node:crypto";
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

/**
 * The adopt is one-way and a retry passes the endpoint only with the identical manifest, so an
 * adoption the root's witness already records is never sent again: the stage is reset instead.
 */
export function refuseRecordedAdoption(witness: unknown) {
  const body =
    witness && typeof witness === "object" ? (witness as { result?: unknown }).result : undefined;
  const kind = body && typeof body === "object" ? (body as { kind?: unknown }).kind : undefined;
  if (kind === "unattested-active")
    throw new Error(
      "The root already records an adoption; nothing was sent. Reset the stage (destroy, fresh baseline, adopt)",
    );
  if (kind !== "witness") throw new Error("The root's witness could not be read; nothing was sent");
}

/**
 * A root never adopted keeps no record for its legacy target, and the endpoint's witness read
 * refuses exactly so: 409, closed reason identity. Only that refusal of the witness read means
 * "no adoption recorded"; any other failure refuses. A record the read misses can still never be
 * overwritten: the endpoint's admit reads the record under the proof's target and refuses first.
 */
export async function noAdoptionRecorded(error: unknown) {
  const [{ BarrierRefusal }, { canonical, digest }] = await Promise.all([
    import("../release-barrier/refusal.ts"),
    import("../release-barrier/manifest.ts"),
  ]);
  if (!(error instanceof BarrierRefusal) || error.reason !== "runtime-handoff-response-refused")
    return false;
  const changed = error.delta?.changed ?? [];
  const at = (path: string) => changed.find((entry) => entry.path === path)?.new;
  return (
    at("handoff.command.action") === "witness" &&
    at("handoff.response.status") === digest(canonical(409)) &&
    [at("handoff.response.reason"), at("handoff.response.code")].some(
      (value) => typeof value === "string" && /(?:^|_)identity$/u.test(value),
    )
  );
}

/**
 * What the policies must be before anything is sent: none at all (an adopt with no seed), or the
 * infra-only seed's set. Without either named, nothing is adopted.
 */
export function expectedPolicies(
  env: NodeJS.ProcessEnv,
): "none" | { cleanPool: string; emptyPools: string[] } {
  if (env.STAGE_ADOPT_POLICIES === "none") return "none";
  const cleanPool = env.STAGE_ADOPT_CLEAN_POOL ?? "";
  const emptyPools = JSON.parse(env.STAGE_ADOPT_EMPTY_POOLS ?? "[]") as string[];
  if (!cleanPool || !emptyPools.length)
    throw new Error("Adopt needs no policies or the seeded pool set to check the policies against");
  return { cleanPool, emptyPools };
}

/** The controller's own policies must be exactly the expected ones. */
export async function policyShape(
  inspect: unknown,
  expected: "none" | { cleanPool: string; emptyPools: readonly string[] },
) {
  if (expected !== "none") return infraOnlyShape(inspect, expected);
  const policies =
    inspect && typeof inspect === "object"
      ? (inspect as { policies?: unknown }).policies
      : undefined;
  const count = Array.isArray(policies) ? policies.length : -1;
  if (count !== 0)
    throw new Error(`The pool controller holds ${count} policies; none were expected`);
}

/** The infra-only seed's policy shape, from the controller's own inspect. */
export async function infraOnlyShape(
  inspect: unknown,
  pools: { cleanPool: string; emptyPools: readonly string[] },
) {
  const { verifyRehearsalPolicies } = await import("./rehearsal-seed.ts");
  const policies = (
    inspect && typeof inspect === "object" ? (inspect as { policies?: unknown }).policies : []
  ) as Parameters<typeof verifyRehearsalPolicies>[0];
  verifyRehearsalPolicies(Array.isArray(policies) ? policies : [], { ...pools, infraOnly: true });
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
  const pools = expectedPolicies(env);
  // As the entry does: a release attempt id, and the cloud app as the working directory before
  // anything loads Alchemy, which captures it once (`initialCwd`) and resolves commands from it.
  const cloud = fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url));
  Object.assign(process.env, { BASALT_RELEASE_ATTEMPT: randomUUID(), CI: "true" });
  process.chdir(cloud);
  const { initialCwd } = await import("alchemy/Util/Node");
  if (initialCwd !== process.cwd())
    throw new Error("Alchemy loaded before the adopt moved into the cloud app; nothing was sent");
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
    { verifyContainerHealth },
    { legacyAdoptionTarget },
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
    import("../release-barrier/container-health.ts"),
    import("../release-barrier/legacy-adoption-target.ts"),
  ]);
  const directory = fileURLToPath(new URL("../../.local/stage-adopt/", import.meta.url));
  const writer = ordinaryReleaseWriter(env);
  const code = { candidate: writer.candidate, workerInput: poolWorkerRevision };
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
          // The fixture's policies reach the controller on its membership pass: wait, bounded, for
          // exactly the infra-only shape, then for it to hold still.
          let shaped: unknown;
          for (let attempt = 0; attempt < 24; attempt += 1) {
            const read = yield* Effect.promise(() => client.inspect());
            const refused = yield* Effect.promise(() =>
              policyShape(read, pools).then(
                () => undefined,
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
              ),
            );
            if (!refused) {
              shaped = read;
              break;
            }
            if (attempt === 23)
              throw new Error(`The pools' policies are not the expected shape: ${refused}`);
            yield* Effect.promise(() => new Promise((done) => setTimeout(done, 5_000)));
          }
          const first = shaped;
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
          // Never a second adoption: read the root's own record first and refuse if it has one.
          const observed = yield* Effect.promise(() =>
            verifyContainerHealth(state.target, input, AbortSignal.timeout(15_000)),
          );
          const witnessed = yield* Effect.promise(() =>
            client
              .call({
                action: "witness",
                target: legacyAdoptionTarget(state.applications.root, observed.instanceId),
              })
              .then(
                (body) => ({ body }),
                (error: unknown) => ({ error }),
              ),
          );
          if ("error" in witnessed) {
            if (!(yield* Effect.promise(() => noAdoptionRecorded(witnessed.error))))
              throw new Error(
                `The root's witness could not be read; nothing was sent: ${
                  witnessed.error instanceof Error
                    ? witnessed.error.message
                    : String(witnessed.error)
                }`,
              );
          } else refuseRecordedAdoption(witnessed.body);
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
