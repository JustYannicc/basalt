/**
 * The parts of a release run's wire guard configuration the entry derives from State and the
 * command (deploy.ts), kept here so tests hold them to the guard itself.
 */
import { Data, Effect } from "effect";

/** A container application as its State row records it. */
export interface RecordedApplication {
  readonly id: string;
  readonly name?: string | undefined;
}

/**
 * The applications the run's guard holds. The root is held by its own id and name, and only the
 * root's pair tells the guard it knows the root (`rootRequired`). The policy's held applications
 * sit beside it, never in the root's lists: a held name must not stand in for the root's.
 */
export function wireHolds(
  root: RecordedApplication | undefined,
  held: ReadonlyArray<RecordedApplication | undefined>,
) {
  return {
    rootApplications: root ? [root.id] : [],
    rootApplicationNames: root?.name ? [root.name] : [],
    heldApplications: held.flatMap((application) =>
      application
        ? [
            application.name
              ? { id: application.id, name: application.name }
              : { id: application.id },
          ]
        : [],
    ),
  };
}

/** The application a container's State row records: its id, and the name it was created under. */
export function recordedApplicationOf(row: unknown): RecordedApplication | undefined {
  const attr = (
    row as { attr?: { applicationId?: unknown; applicationName?: unknown } } | undefined
  )?.attr;
  const id = attr?.applicationId;
  const name = attr?.applicationName;
  return typeof id === "string" && id
    ? { id, name: typeof name === "string" && name ? name : undefined }
    : undefined;
}

/** A stage's State store, as the release entry opens it (Alchemy's StateService). */
export interface StageStore<E> {
  readonly id: string;
  readonly getVersion: () => Effect.Effect<number, E>;
  readonly get: (key: { stack: string; stage: string; fqn: string }) => Effect.Effect<unknown, E>;
  readonly set: (key: {
    stack: string;
    stage: string;
    fqn: string;
    value: never;
  }) => Effect.Effect<unknown, E>;
  readonly delete: (key: { stack: string; stage: string; fqn: string }) => Effect.Effect<void, E>;
}

/**
 * A stage's State rows under one stack's key. Every row the release reads for its holds, and every
 * row a repair reads or writes, is keyed here, each by its own fqn.
 */
export const stageRowsOf = <E>(state: StageStore<E>, stack: string, stage: string) => {
  const at = { stack, stage };
  const row = (fqn: string) => state.get({ ...at, fqn });
  return {
    state,
    at,
    row,
    application: (fqn: string) => row(fqn).pipe(Effect.map(recordedApplicationOf)),
    store: {
      get: row,
      set: (fqn: string, value: unknown) => state.set({ ...at, fqn, value: value as never }),
      delete: (fqn: string) => state.delete({ ...at, fqn }),
    },
  };
};
export type StageRows<E> = ReturnType<typeof stageRowsOf<E>>;

/** Commands that only read production: the guard refuses anything but reads while they run. */
export const readOnlyRun = (stage: string, command: string, digest: string | undefined) =>
  stage === "production" &&
  (["plan", "preflight", "snapshot", "serving"].includes(command) ||
    // A repair without the reviewed digest only plans the repair.
    (command === "repair" && !digest));

/** Production under a reviewed policy records no root application: the run stops. */
export class NoRootRecorded extends Data.TaggedError("NoRootRecorded")<{
  readonly fqn: string;
}> {}

/**
 * The holds of one run, from the policy and the rows State records (`recorded`, by fqn). Every
 * reviewed release, and every production command, leaves the root application as recorded;
 * previews roll it freely. A stage under a policy keeps its root by the same rules once its row
 * records one, so a rehearsal runs them as production does.
 */
export const wireConfigFor = <E>(input: {
  readonly stage: string;
  readonly policy:
    | {
        readonly rootFqn: string;
        readonly held: ReadonlyArray<string>;
      }
    | undefined;
  readonly recorded: (fqn: string) => Effect.Effect<RecordedApplication | undefined, E>;
}) =>
  Effect.gen(function* () {
    const production = input.stage === "production";
    const rootFqn = input.policy?.rootFqn ?? (production ? "PoolContainer" : undefined);
    const root = rootFqn ? yield* input.recorded(rootFqn) : undefined;
    if (!root && rootFqn && production && input.policy)
      return yield* new NoRootRecorded({ fqn: rootFqn });
    const held: (RecordedApplication | undefined)[] = [];
    for (const fqn of input.policy?.held ?? []) held.push(yield* input.recorded(fqn));
    const holds = wireHolds(root, held);
    // Frozen, as the entry freezes the guard's config once they are in it: nothing after this
    // function edits what the run holds.
    for (const list of Object.values(holds)) Object.freeze(list);
    for (const application of holds.heldApplications) Object.freeze(application);
    return {
      ...holds,
      // Production keeps the root from the first request on; another stage once it records one.
      rootRequired: production || root !== undefined,
      // A root known by id alone makes the guard refuse every container write of the run.
      unnamedRoot: root !== undefined && !root.name,
    };
  });
