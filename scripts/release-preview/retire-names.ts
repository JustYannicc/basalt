/**
 * The names Alchemy gives an unnamed Cloudflare resource under the rehearsal stack and a stage,
 * each kind by its own provider's rule in the installed build. A name cut to its provider's limit
 * keeps only a hash of the stack, stage, id and instance, so only the row's own cut name matches,
 * and only at the limit and case its own provider uses.
 */
import type { Effect as EffectModule } from "effect";

type Named = EffectModule.Effect<string, never, unknown>;

// Alchemy's package exports no subpath for its name helpers, so each is loaded from beside the
// `PhysicalName` module its exports resolve to: the same installed build, the same tags.
const beside = (file: string) => new URL(file, import.meta.resolve("alchemy/PhysicalName")).href;
const helper = async <F>(file: string, name: string): Promise<F> => {
  const found = ((await import(beside(file))) as Record<string, unknown>)[name];
  if (typeof found !== "function") throw new Error(`Alchemy's ${file} exports no ${name}`);
  return found as F;
};

/** The loaders of each provider's own name helper; a test swaps one for a failing one. */
export const alchemyNamers = {
  worker: () =>
    helper<(id: string, name: undefined) => Named>(
      "./Cloudflare/Workers/WorkerName.js",
      "createWorkerName",
    ),
  container: () =>
    helper<(id: string, name: undefined) => Named>(
      "./Cloudflare/Containers/ContainerBundle.js",
      "createContainerApplicationName",
    ),
  workflow: () =>
    helper<(scriptName: string, className: string) => Named>(
      "./Cloudflare/Workflows/WorkflowName.js",
      "generateWorkflowName",
    ),
};
export type AlchemyNamers = Partial<typeof alchemyNamers>;

/**
 * The names Alchemy gives an unnamed resource of `type`, from the row's own id and instance, by
 * that kind's provider:
 * - `Cloudflare.Worker`: its own `createWorkerName` (54, lowercased).
 * - `Cloudflare.Container`: its own `createContainerApplicationName` (64, lowercase).
 * - `Cloudflare.R2.Bucket`: 63, then lowercased, as `Bucket.ts`'s `createBucketName`, which its
 *   provider keeps private.
 * - `Cloudflare.Hyperdrive`: 64, lowercase, as `Connection.ts`'s `createConfigName`, private too.
 * - `Cloudflare.DNS.Record`: none; a record is always named by the stack.
 * - Any other kind, an explicitly named Workflow's included: the 64/63 variants either case, as
 *   before. An unnamed Workflow's name derives from its host Worker; see {@link workflowName}.
 * A helper that fails to load throws, so the proof, and the retire, stop there.
 */
export async function derivedNames(
  id: string,
  instanceId: string,
  stage: string,
  type: string,
  namers: AlchemyNamers = {},
) {
  const { createPhysicalName } = await import("alchemy/PhysicalName");
  const { StackContext } = await import("alchemy/StackContext");
  const { Stage } = await import("alchemy/Stage");
  const { InstanceId } = await import("alchemy/InstanceId");
  const { Effect } = await import("effect");
  const run = <E, R>(name: EffectModule.Effect<string, E, R>) =>
    Effect.runPromise(
      name.pipe(
        Effect.provideService(StackContext, { name: "basalt-rehearsal" } as never),
        Effect.provideService(Stage, stage),
        Effect.provideService(InstanceId, instanceId),
      ) as EffectModule.Effect<string, E>,
    );
  switch (type) {
    case "Cloudflare.Worker": {
      const createWorkerName = await (namers.worker ?? alchemyNamers.worker)();
      return [await run(createWorkerName(id, undefined))];
    }
    case "Cloudflare.Container": {
      const create = await (namers.container ?? alchemyNamers.container)();
      return [await run(create(id, undefined))];
    }
    case "Cloudflare.R2.Bucket":
      return [(await run(createPhysicalName({ id, instanceId, maxLength: 63 }))).toLowerCase()];
    case "Cloudflare.Hyperdrive":
      return [await run(createPhysicalName({ id, instanceId, lowercase: true }))];
    case "Cloudflare.DNS.Record":
      return [];
  }
  const names: string[] = [];
  for (const maxLength of [64, 63])
    for (const lowercase of [true, false]) {
      const name = await run(createPhysicalName({ id, instanceId, maxLength, lowercase }));
      names.push(name, name.toLowerCase());
    }
  return names;
}

/**
 * The name Alchemy's own `generateWorkflowName` gives an unnamed Workflow hosted by `scriptName`
 * for `className`: the two joined and lowercased, cut to 55, then 8 hex of their sha256.
 */
export async function workflowName(
  scriptName: string,
  className: string,
  namers: AlchemyNamers = {},
) {
  const generate = await (namers.workflow ?? alchemyNamers.workflow)();
  const { Effect } = await import("effect");
  return Effect.runPromise(generate(scriptName, className) as EffectModule.Effect<string>);
}
