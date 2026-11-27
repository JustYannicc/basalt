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
import { Data, Effect, Option } from "effect";

/**
 * What `alchemy drift` observes of one row, read the way it reads every row (Drift.ts): the row's
 * own provider, in the mode that wrote it, reads with the row's props and attributes. The
 * container provider reads a placeholder by its application's explicit name. It reads only.
 */
export const observeRow = (fqn: string, row: ResourceState) =>
  Effect.gen(function* () {
    const provider = yield* findProviderByType(row.resourceType as never, stampedMode(row));
    if (!provider.read) return undefined;
    const store = Option.getOrElse(yield* Effect.serviceOption(ArtifactStore), createArtifactStore);
    const observed = yield* provider
      .read({
        id: row.logicalId,
        fqn,
        instanceId: row.instanceId,
        olds: row.props as never,
        output: row.attr as never,
      })
      .pipe(
        // The pinned Alchemy types every provider read's error as `any`; the repair carries it as
        // the cause. alchemy-run/alchemy#3200 types it (`ProviderError`), and this file's one
        // `anyUnknownInErrorContext` entry in the Effect diagnostics baseline goes with the
        // framework upgrade that brings it.
        Effect.mapError((cause) => new ProviderReadFailed({ fqn, cause })),
        Effect.provideService(Artifacts, makeScopedArtifacts(store, fqn)),
        Effect.provideService(InstanceId, row.instanceId),
      );
    if (observed === undefined) return { status: "missing" } satisfies Observation;
    // A placeholder's attributes never equal a live read (its id is local), and planRepair checks
    // the read's identity itself, so whatever the provider finds is drift from the placeholder.
    return { status: "drifted", actual: stripUnowned(observed) } satisfies Observation;
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
}): RepairPlan | RepairRefused {
  const placeholder = placeholderOf(input.fqn, input.row);
  if (placeholder instanceof RepairRefused) return placeholder;
  const { id, name, accountId, className } = placeholder;
  const refuse = (why: string) => new RepairRefused({ fqn: input.fqn, why });
  const base = { fqn: input.fqn, placeholder: id, name, accountId };
  if (!input.observed) return refuse("Alchemy's drift read did not read the row");
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
    const plan = planRepair({
      fqn: input.fqn,
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
    const write =
      plan.action === "forget"
        ? input.store.delete(input.fqn)
        : input.store.set(input.fqn, adoptedRow(row, plan, observed?.actual));
    yield* write.pipe(
      Effect.mapError(
        (cause) => new RepairStepFailed({ fqn: input.fqn, check: "write State", cause }),
      ),
    );
    return plan;
  });
