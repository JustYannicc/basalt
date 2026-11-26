/**
 * Repairs a container application's State row that a stopped apply left holding a local
 * placeholder, so the stage can release again.
 *
 * Alchemy commits a new container's row with a local `dev:` application id before the Worker that
 * binds it uploads, and creates the application only after that upload, with the namespace the
 * Worker resolved. An apply that stops in between leaves the placeholder, and every later plan of
 * that row is refused (plan-check.ts, `container-placeholder-not-created`). State cannot tell
 * whether the create reached Cloudflare, so the repair reads the account first:
 *
 * - no application carries the row's name: the create never landed, so the row holds nothing live
 *   and is forgotten. The release that stopped then runs again as it was planned.
 * - one does: the create landed and its commit was lost. The row is rewritten to that application,
 *   attached to the namespace the Worker records, and the next release reads it as live.
 *
 * Anything else is refused, and the repair changes nothing.
 */
import { createHash } from "node:crypto";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Data, Effect, Redacted } from "effect";

/** An application as the account lists it, decoded as the container provider decodes it. */
export type ListedApplication = Pick<
  Containers.ContainerApplicationItem,
  "id" | "name" | "durableObjects"
>;

/** The account's applications, through the provider's own SDK call. */
export const listApplications =
  (token: Redacted.Redacted<string>, apiBaseUrl?: string) => (accountId: string) =>
    Containers.listContainerApplications({ accountId }).pipe(
      Effect.provideService(
        Credentials,
        Effect.succeed(
          apiTokenCredentials({
            apiToken: Redacted.value(token),
            ...(apiBaseUrl ? { apiBaseUrl } : {}),
          }),
        ),
      ),
      Effect.timeout("60 seconds"),
    );

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

export class RepairRefused extends Data.TaggedError("RepairRefused")<{
  readonly fqn: string;
  readonly reason: string;
}> {}

interface Row {
  readonly resourceType?: unknown;
  readonly status?: unknown;
  readonly providerMode?: unknown;
  readonly props?: { readonly name?: unknown; readonly className?: unknown };
  readonly attr?: {
    readonly applicationId?: unknown;
    readonly applicationName?: unknown;
    readonly accountId?: unknown;
  };
  readonly bindings?: ReadonlyArray<{ readonly sid: string; readonly data: unknown }>;
}

const placeholderPrefix = "dev:";

/** The row's facts the repair rests on, or why it will not touch the row. */
export function placeholderOf(fqn: string, value: unknown) {
  const refuse = (reason: string) => new RepairRefused({ fqn, reason });
  if (value === undefined) return refuse("State has no row for it");
  const row = value as Row;
  if (row.resourceType !== "Cloudflare.Container") return refuse("its row is not a container");
  const id = row.attr?.applicationId;
  if (typeof id !== "string" || !id.startsWith(placeholderPrefix))
    return refuse("its row records a live application, not a placeholder");
  // A local-mode row's id is local by design; only a live run leaves a placeholder to repair.
  if (row.providerMode === "local") return refuse("its row was written in local mode");
  const name = row.attr?.applicationName;
  // Alchemy names a generated application per generation; only an explicit name tells which
  // listed application is this row's.
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

const attachment = (data: unknown) =>
  typeof data === "object" && data !== null && "durableObjects" in data;

/**
 * What the repair does to the row, from the row, the namespace its Worker records for the row's
 * class, and the applications the row's account lists.
 */
export function planRepair(input: {
  readonly fqn: string;
  readonly row: unknown;
  readonly hostedNamespace: (className: string) => string | undefined;
  readonly applications: ReadonlyArray<ListedApplication>;
}): RepairPlan | RepairRefused {
  const placeholder = placeholderOf(input.fqn, input.row);
  if (placeholder instanceof RepairRefused) return placeholder;
  const { id, name, accountId, className } = placeholder;
  const refuse = (reason: string) => new RepairRefused({ fqn: input.fqn, reason });
  const named = input.applications.filter((application) => application.name === name);
  const base = { fqn: input.fqn, placeholder: id, name, accountId };
  if (named.length === 0) return { ...base, action: "forget" };
  if (named.length > 1)
    return refuse(`the account lists ${named.length} applications under its name`);
  const [live] = named;
  const namespace = input.hostedNamespace(className);
  // Cloudflare creates an application only with its Durable Object binding, so a live one is
  // attached; it must be the namespace the Worker records for the class, or it is not this row's.
  const attached = live!.durableObjects?.namespaceId;
  if (!namespace)
    return refuse("an application exists, but the Worker records no namespace for its class");
  if (attached !== namespace)
    return refuse(
      "the application under its name is attached to another namespace than the Worker records",
    );
  return { ...base, action: "adopt", application: live!.id, namespace };
}

/** The row an adopt writes: the placeholder's, pointed at the live application and attached. */
export function adoptedRow(row: unknown, plan: Extract<RepairPlan, { action: "adopt" }>) {
  const value = row as Row & { attr: Record<string, unknown> };
  return {
    ...value,
    status: "created",
    attr: {
      ...value.attr,
      applicationId: plan.application,
      durableObjects: { namespaceId: plan.namespace },
    },
    bindings: (value.bindings ?? []).map((binding) =>
      attachment(binding.data)
        ? {
            ...binding,
            data: { ...(binding.data as object), durableObjects: { namespaceId: plan.namespace } },
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

/** A read or write the repair needed failed; the repair stops, naming only what it was doing. */
export class RepairStepFailed extends Data.TaggedError("RepairStepFailed")<{
  readonly fqn: string;
  readonly step: "read State" | "list applications" | "write State";
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
  readonly list: (accountId: string) => Effect.Effect<ReadonlyArray<ListedApplication>, L, R>;
}

/** Plans the repair from State and the account; reads only. */
export const readRepair = <E, L, R>(input: RepairInput<E, L, R>) =>
  Effect.gen(function* () {
    const failed = (step: RepairStepFailed["step"]) => (cause: unknown) =>
      new RepairStepFailed({ fqn: input.fqn, step, cause });
    const row = yield* input.store.get(input.fqn).pipe(Effect.mapError(failed("read State")));
    const placeholder = placeholderOf(input.fqn, row);
    if (placeholder instanceof RepairRefused) return yield* placeholder;
    const worker = (yield* input.store
      .get(input.worker)
      .pipe(Effect.mapError(failed("read State")))) as
      | { attr?: { durableObjectNamespaces?: Record<string, unknown> } }
      | undefined;
    const applications = yield* input
      .list(placeholder.accountId)
      .pipe(Effect.mapError(failed("list applications")));
    const plan = planRepair({
      fqn: input.fqn,
      row,
      hostedNamespace: (className) => {
        const id = worker?.attr?.durableObjectNamespaces?.[className];
        return typeof id === "string" && id ? id : undefined;
      },
      applications,
    });
    if (plan instanceof RepairRefused) return yield* plan;
    return { plan, row };
  });

/** Applies the repair the reviewer approved, after planning it again from fresh reads. */
export const applyRepair = <E, L, R>(input: RepairInput<E, L, R> & { readonly digest: string }) =>
  Effect.gen(function* () {
    const { plan, row } = yield* readRepair(input);
    if (repairDigest(plan) !== input.digest)
      return yield* new RepairRefused({
        fqn: input.fqn,
        reason: "the repair differs from the one approved",
      });
    const write =
      plan.action === "forget"
        ? input.store.delete(input.fqn)
        : input.store.set(input.fqn, adoptedRow(row, plan));
    yield* write.pipe(
      Effect.mapError(
        (cause) => new RepairStepFailed({ fqn: input.fqn, step: "write State", cause }),
      ),
    );
    return plan;
  });
