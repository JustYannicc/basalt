/**
 * Repairs a container application's State row that a stopped apply left holding a local
 * placeholder, so the stage can release again.
 *
 * Alchemy commits a new container's row with a local `dev:` application id before the Worker that
 * binds it uploads, and creates the application only after that upload, with the namespace the
 * Worker resolved. An apply that stops in between leaves the placeholder, and every later plan of
 * that row is refused (plan-check.ts, `container-placeholder-not-created`). State cannot tell
 * whether the create reached Cloudflare, so the repair asks Alchemy's own drift read first: the
 * container provider reads a placeholder by its application's explicit name.
 *
 * - nothing under the name: the create never landed, so the row holds nothing live and is
 *   forgotten, as `alchemy state delete` would. The release that stopped then runs again.
 * - an application under it: the create landed and its commit was lost. The row takes the
 *   attributes the provider read, attached to the namespace the Worker records, and the next
 *   release reads it as live.
 *
 * Anything else is refused, and the repair changes nothing.
 */
import { createHash } from "node:crypto";
import { stripUnowned } from "alchemy/AdoptPolicy";
import {
  Artifacts,
  ArtifactStore,
  createArtifactStore,
  makeScopedArtifacts,
} from "alchemy/Artifacts";
import { InstanceId } from "alchemy/InstanceId";
import { findProviderByType } from "alchemy/Provider";
import { stampedMode } from "alchemy/ProviderMode";
import type { ResourceState } from "alchemy/State/ResourceState";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { type Context, Data, Effect, Option } from "effect";
import { safeJson } from "./safe-json.ts";
import { type StackState, stateStoreRefusal } from "./stack-config.ts";

/** A provider lifecycle failure as alchemy-run/alchemy#3200 types it: tagged, with a message. */
type ProviderError = { readonly _tag: string; readonly message?: string };

/**
 * What `alchemy drift` observes of one row, read the way it reads every row (Drift.ts): the row's
 * own provider, in the mode that wrote it, reads with the row's props and attributes. The
 * container provider reads a placeholder by its application's explicit name. It reads only.
 */
export const observeRow = (
  fqn: string,
  row: ResourceState,
  find: typeof findProviderByType = findProviderByType,
) =>
  Effect.gen(function* () {
    const provider = yield* find(row.resourceType as never, stampedMode(row));
    if (!provider.read) return undefined;
    const store = Option.getOrElse(yield* Effect.serviceOption(ArtifactStore), createArtifactStore);
    // The pinned Alchemy declares every provider read's error `any`. alchemy-run/alchemy#3200
    // declares it `ProviderError`; this binding states the same type at the one call, and goes with
    // the framework upgrade that brings it. The error is carried only as a cause.
    const read: (
      input: Parameters<NonNullable<typeof provider.read>>[0],
    ) => Effect.Effect<unknown, ProviderError, InstanceId | Artifacts> =
      provider.read.bind(provider);
    const observed = yield* read({
      id: row.logicalId,
      fqn,
      instanceId: row.instanceId,
      olds: row.props as never,
      output: row.attr as never,
    }).pipe(
      Effect.mapError((cause) => new ProviderReadFailed({ fqn, cause })),
      Effect.provideService(Artifacts, makeScopedArtifacts(store, fqn)),
      Effect.provideService(InstanceId, row.instanceId),
    );
    // The account the read listed: the session's Cloudflare environment, as the provider reads it.
    const environment = yield* Effect.serviceOption(CloudflareEnvironment);
    const account = Option.isSome(environment) ? (yield* environment.value).accountId : undefined;
    if (observed === undefined) return { status: "missing", account } satisfies Observation;
    // A placeholder's attributes never equal a live read (its id is local), and planRepair checks
    // the read's identity itself, so whatever the provider finds is drift from the placeholder.
    return {
      status: "drifted",
      actual: stripUnowned(observed as object),
      account,
    } satisfies Observation;
  });

/** The row's provider failed to read it; the repair stops. */
export class ProviderReadFailed extends Data.TaggedError("ProviderReadFailed")<{
  readonly fqn: string;
  readonly cause: unknown;
}> {}

/** What Alchemy's drift read observed of the row. */
export interface Observation {
  readonly status: "in-sync" | "drifted" | "missing";
  readonly actual?: unknown;
  /** The account the read listed, as the session's Cloudflare environment names it. */
  readonly account?: string | undefined;
}

export type RepairPlan =
  | {
      readonly fqn: string;
      readonly action: "forget";
      readonly placeholder: string;
      readonly name: string;
      readonly accountId: string;
    }
  | {
      readonly fqn: string;
      readonly action: "adopt";
      readonly placeholder: string;
      readonly name: string;
      readonly accountId: string;
      readonly application: string;
      readonly namespace: string;
    };

/** The repair will not touch the row; `why` is public text with no names or ids. */
export class RepairRefused extends Data.TaggedError("RepairRefused")<{
  readonly fqn: string;
  readonly why: string;
}> {}

interface Row {
  readonly resourceType?: unknown;
  readonly status?: unknown;
  readonly providerMode?: unknown;
  readonly old?: unknown;
  readonly deleteFirst?: unknown;
  readonly adopting?: unknown;
  readonly props?: { readonly name?: unknown; readonly className?: unknown };
  readonly attr?: {
    readonly applicationId?: unknown;
    readonly applicationName?: unknown;
    readonly accountId?: unknown;
  };
  readonly bindings?: ReadonlyArray<{ readonly sid: string; readonly data: unknown }>;
}

const placeholderPrefix = "dev:";
const attachment = (data: unknown) =>
  typeof data === "object" && data !== null && "durableObjects" in data;

/** The row's facts the repair rests on, or why it will not touch the row. */
export function placeholderOf(fqn: string, value: unknown) {
  const refuse = (why: string) => new RepairRefused({ fqn, why });
  if (value === undefined) return refuse("State has no row for it");
  const row = value as Row;
  if (row.resourceType !== "Cloudflare.Container") return refuse("its row is not a container");
  const id = row.attr?.applicationId;
  if (typeof id !== "string" || !id.startsWith(placeholderPrefix))
    return refuse("its row records a live application, not a placeholder");
  // A stopped create leaves the row `created` by its first reconcile, with nothing under it.
  // Any other status, or an older generation under `old`, belongs to an interrupted replace or
  // delete, which records a live application the repair must not forget or overwrite; Alchemy's
  // deploy owns those, and its drift read skips them.
  if (row.status !== "created") return refuse("its row is not a finished first create");
  if (row.old !== undefined || row.deleteFirst !== undefined || row.adopting !== undefined)
    return refuse("its row carries an older generation or a pending replacement");
  // A local-mode row's id is local by design; only a live run leaves a placeholder to repair.
  if (row.providerMode === "local") return refuse("its row was written in local mode");
  const name = row.attr?.applicationName;
  // Alchemy names a generated application per generation; only an explicit name tells which
  // application in the account is this row's.
  if (typeof name !== "string" || !name || row.props?.name !== name)
    return refuse(
      "its application is not explicitly named, so the account cannot say which is its",
    );
  const accountId = row.attr?.accountId;
  if (typeof accountId !== "string" || !accountId) return refuse("its row records no account");
  const className = row.props?.className;
  if (typeof className !== "string" || !className) return refuse("its row names no class");
  if (!(row.bindings ?? []).some((binding) => attachment(binding.data)))
    return refuse("its row records no Worker attachment to restore");
  return { id, name, accountId, className };
}

/**
 * What the repair does to the row, from the row, the namespace its Worker records for the row's
 * class, and what Alchemy's drift read observed of it.
 */
export function planRepair(input: {
  readonly fqn: string;
  readonly row: unknown;
  readonly hostedNamespace: (className: string) => string | undefined;
  readonly observed: Observation | undefined;
  /** Applications other rows record (the root's, the held ones): never this row's to adopt. */
  readonly taken?: { readonly ids: ReadonlySet<string>; readonly names: ReadonlySet<string> };
}): RepairPlan | RepairRefused {
  const placeholder = placeholderOf(input.fqn, input.row);
  if (placeholder instanceof RepairRefused) return placeholder;
  const { id, name, accountId, className } = placeholder;
  const refuse = (why: string) => new RepairRefused({ fqn: input.fqn, why });
  const base = { fqn: input.fqn, placeholder: id, name, accountId };
  if (!input.observed) return refuse("Alchemy's drift read did not read the row");
  // The provider lists the session's account: a row recorded under another would read as missing
  // there and be forgotten while its application lives on.
  if (input.observed.account !== accountId)
    return refuse("the account Alchemy's read listed is not the one the row records");
  if (input.observed.status === "missing") return { ...base, action: "forget" };
  if (input.observed.status !== "drifted")
    return refuse("Alchemy's drift read found the placeholder in sync with the account");
  const live = input.observed.actual as
    | {
        applicationId?: unknown;
        applicationName?: unknown;
        accountId?: unknown;
        durableObjects?: { namespaceId?: unknown };
      }
    | undefined;
  if (
    typeof live?.applicationId !== "string" ||
    live.applicationId.startsWith(placeholderPrefix) ||
    live.applicationName !== name ||
    live.accountId !== accountId
  )
    return refuse("the application Alchemy read is not the row's");
  const namespace = input.hostedNamespace(className);
  // Cloudflare creates an application only with its Durable Object binding, so a live one is
  // attached; it must be the namespace the Worker records for the class, or it is not this row's.
  if (!namespace)
    return refuse("an application exists, but the Worker records no namespace for its class");
  if (live.durableObjects?.namespaceId !== namespace)
    return refuse(
      "the application under its name is attached to another namespace than the Worker records",
    );
  const taken = input.taken;
  if (
    taken &&
    (taken.ids.has(live.applicationId.toLowerCase()) || taken.names.has(name.toLowerCase()))
  )
    return refuse("another row records the application under its name");
  return { ...base, action: "adopt", application: live.applicationId, namespace };
}

/** The row an adopt writes: the attributes the provider read, and the Worker attachment. */
export function adoptedRow(
  row: unknown,
  plan: Extract<RepairPlan, { action: "adopt" }>,
  actual: unknown,
) {
  const value = row as Row;
  return {
    ...value,
    status: "created",
    attr: actual,
    bindings: (value.bindings ?? []).map((binding) =>
      attachment(binding.data)
        ? {
            ...binding,
            data: {
              ...(binding.data as object),
              durableObjects: { namespaceId: plan.namespace },
            },
          }
        : binding,
    ),
  };
}

/** The digest a reviewer approves: a later run applies the repair only if it plans the same. */
export const repairDigest = (plan: RepairPlan) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(plan).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");

/** The release that finishes the stopped one, once the repair has run. */
export const nextRelease = (plan: RepairPlan) =>
  plan.action === "forget"
    ? "the release that stopped, again, at the same commit (route-gateway-class for the declare)"
    : "an ordinary release: the row now records the live application";

/** A step the repair needed failed; `check` names the step, publicly. */
export class RepairStepFailed extends Data.TaggedError("RepairStepFailed")<{
  readonly fqn: string;
  readonly check: "read State" | "read the account" | "write State";
  readonly cause: unknown;
}> {}

/** The stage's State, as far as the repair touches it. */
export interface RepairStore<E> {
  readonly get: (fqn: string) => Effect.Effect<unknown, E>;
  readonly set: (fqn: string, value: unknown) => Effect.Effect<unknown, E>;
  readonly delete: (fqn: string) => Effect.Effect<void, E>;
}

export interface RepairInput<E, L, R> {
  readonly fqn: string;
  /** Rows whose applications the repair never adopts for this one: the root's, the held ones. */
  readonly reserved?: ReadonlyArray<string>;
  /** The Worker that binds the container: its row records the class's namespace. */
  readonly worker: string;
  readonly store: RepairStore<E>;
  /** Alchemy's drift read of the row; reads the account, writes nothing. */
  readonly observe: (fqn: string) => Effect.Effect<Observation | undefined, L, R>;
}

/** Plans the repair from State and Alchemy's drift read; reads only. */
export const readRepair = <E, L, R>(input: RepairInput<E, L, R>) =>
  Effect.gen(function* () {
    const failed = (check: RepairStepFailed["check"]) => (cause: unknown) =>
      new RepairStepFailed({ fqn: input.fqn, check, cause });
    const row = yield* input.store.get(input.fqn).pipe(Effect.mapError(failed("read State")));
    const placeholder = placeholderOf(input.fqn, row);
    if (placeholder instanceof RepairRefused) return yield* placeholder;
    const worker = (yield* input.store
      .get(input.worker)
      .pipe(Effect.mapError(failed("read State")))) as
      | { attr?: { durableObjectNamespaces?: Record<string, unknown> } }
      | undefined;
    const observed = yield* input
      .observe(input.fqn)
      .pipe(Effect.mapError(failed("read the account")));
    const taken = { ids: new Set<string>(), names: new Set<string>() };
    for (const other of input.reserved ?? []) {
      if (other === input.fqn) continue;
      const recorded = (yield* input.store
        .get(other)
        .pipe(Effect.mapError(failed("read State")))) as Row | undefined;
      const { applicationId, applicationName } = recorded?.attr ?? {};
      if (typeof applicationId === "string") taken.ids.add(applicationId.toLowerCase());
      if (typeof applicationName === "string") taken.names.add(applicationName.toLowerCase());
    }
    const plan = planRepair({
      fqn: input.fqn,
      taken,
      row,
      hostedNamespace: (className) => {
        const id = worker?.attr?.durableObjectNamespaces?.[className];
        return typeof id === "string" && id ? id : undefined;
      },
      observed,
    });
    if (plan instanceof RepairRefused) return yield* plan;
    return { plan, row, observed };
  });

/** Applies the repair the reviewer approved, after planning it again from fresh reads. */
export const applyRepair = <E, L, R>(input: RepairInput<E, L, R> & { readonly digest: string }) =>
  Effect.gen(function* () {
    const { plan, row, observed } = yield* readRepair(input);
    if (repairDigest(plan) !== input.digest)
      return yield* new RepairRefused({
        fqn: input.fqn,
        why: "the repair differs from the one approved",
      });
    // The row is read again just before the write: one a running apply committed since is not
    // the row this repair was planned from, and is left alone.
    const now = yield* input.store
      .get(input.fqn)
      .pipe(
        Effect.mapError(
          (cause) => new RepairStepFailed({ fqn: input.fqn, check: "read State", cause }),
        ),
      );
    if (!sameRow(now, row))
      return yield* new RepairRefused({
        fqn: input.fqn,
        why: "the row changed after the repair was planned",
      });
    const write =
      plan.action === "forget"
        ? input.store.delete(input.fqn)
        : input.store.set(input.fqn, adoptedRow(row, plan, observed?.actual));
    yield* write.pipe(
      Effect.mapError(
        (cause) => new RepairStepFailed({ fqn: input.fqn, check: "write State", cause }),
      ),
    );
    // The row as it was before the write, so a wrong repair can be put back by hand.
    return { plan, before: row };
  });

/** Whether two reads of a row are the same generation: its status, instance and application id. */
const sameRow = (a: unknown, b: unknown) => {
  const key = (value: unknown) => {
    const row = value as (Row & { instanceId?: unknown }) | undefined;
    return [row?.status, row?.instanceId, row?.attr?.applicationId];
  };
  const [x, y] = [key(a), key(b)];
  return x.every((part, index) => part !== undefined && part === y[index]);
};

/**
 * The repair command (deploy.ts repair): it holds the State store to the release's contract
 * first, then plans the repair, or applies the approved one when a digest is given. The record it
 * returns is what the run seals: the plan, and before a write the row as it was, so a wrong repair
 * can be undone.
 */
export const runRepair = <E, L, R, V>(
  input: RepairInput<E, L, R> & {
    readonly digest: string | undefined;
    /** The State store, judged by the contract every release holds it to (stateStoreRefusal). */
    readonly contract: {
      readonly id: string;
      readonly version: Effect.Effect<number, V>;
      readonly state: StackState;
      readonly stage: string;
      readonly runnerLocal: number;
    };
  },
) =>
  Effect.gen(function* () {
    const { contract } = input;
    const refused = stateStoreRefusal(
      { id: contract.id, version: yield* contract.version },
      contract.state,
      contract.stage,
      contract.runnerLocal,
    );
    if (refused) return yield* refused;
    const record = input.digest
      ? yield* applyRepair({ ...input, digest: input.digest })
      : { plan: (yield* readRepair(input)).plan, before: undefined };
    return { ...record, sealed: safeJson(record, 2) };
  });

/**
 * The account read for a row in State: the row as State records it, read by its own provider in
 * the stack's session (`observeRow`). A read that fails is the repair's failure, never "missing".
 */
export const observeRecorded =
  <E, O, C, S>(
    store: RepairStore<E>,
    open: Effect.Effect<{ readonly context: Context.Context<C> }, O, S>,
    observe: typeof observeRow = observeRow,
  ) =>
  (fqn: string) =>
    Effect.gen(function* () {
      const recorded = yield* store.get(fqn);
      if (!recorded) return undefined;
      const session = yield* open;
      return yield* observe(fqn, recorded as ResourceState).pipe(Effect.provide(session.context));
    });

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
 * Everything `deploy.ts repair` does after it opens the stage's store and before it prints: the
 * store held to the release's contract, the row read through its own provider in the stack's
 * session, and the repair planned, or applied when the approved digest is given. The record to
 * seal comes back with it.
 */
export const repairCommand = <E, O, C, S>(input: {
  readonly fqn: string;
  readonly digest: string | undefined;
  readonly worker: string;
  readonly reserved: ReadonlyArray<string>;
  readonly state: StageStore<E>;
  readonly at: { readonly stack: string; readonly stage: string };
  readonly stackState: StackState;
  readonly runnerLocal: number;
  readonly open: Effect.Effect<{ readonly context: Context.Context<C> }, O, S>;
  /** The provider read; Alchemy's own unless a test stands one in. */
  readonly read?: typeof observeRow;
}) => {
  const { state, at } = input;
  const store: RepairStore<E> = {
    get: (fqn) => state.get({ ...at, fqn }),
    set: (fqn, value) => state.set({ ...at, fqn, value: value as never }),
    delete: (fqn) => state.delete({ ...at, fqn }),
  };
  return runRepair({
    fqn: input.fqn,
    worker: input.worker,
    reserved: input.reserved,
    digest: input.digest,
    store,
    observe: observeRecorded(store, input.open, input.read),
    contract: {
      id: state.id,
      version: state.getVersion(),
      state: input.stackState,
      stage: at.stage,
      runnerLocal: input.runnerLocal,
    },
  });
};
