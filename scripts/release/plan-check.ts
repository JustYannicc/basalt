/**
 * The deterministic check between `Stacks.plan` and `Stacks.apply(snapshot)`.
 *
 * It reads Alchemy's own plan and refuses, before anything is applied, a plan that would destroy
 * or recreate a resource, or drop a Durable Object class. It cannot see Durable Object migrations
 * (`new_sqlite_classes`, `deleted_classes`): the plan does not carry them, so a dropped class shows
 * here only as a binding `delete` on the Worker node. The wire guard owns the upload itself.
 *
 * Every mode:
 * - a `replace` creates a new resource and deletes the recorded one, so it is refused unless the
 *   policy's `removals` names its fqn, type and action `replace`; a `delete` or `orphaned` row the
 *   same way (a Command's delete only drops its row). A protected resource is refused whatever
 *   `removals` says. The policy's `protected` list names them, so a reviewed file changes it.
 * - no renames, no Worker binding removed, no class renamed or transferred, and the root container
 *   stays on the pinned image with no build inputs and no other change.
 *
 * Modes: `release` adds nothing. `code-only` admits only code: an update of any Worker but the
 * bulk-import store's, the pinned root's hash, Command runs, and whatever `allow` names; no new
 * binding. `cutover-classes` admits exactly the `allow` list, both ways, and the bulk-import
 * store's Worker must be a noop.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import * as Plan from "alchemy/Plan";
import { Data, Effect, Redacted, Schema } from "effect";
import { sha256Object } from "alchemy/Util/sha256";

const digestRef = /^[a-z0-9.-]+\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/u;
const exactFqn = Schema.String.check(Schema.isPattern(/^[^*?\s]+$/u));
const settingName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u));
const reason = Schema.String.check(Schema.isPattern(/\S/u));

export const PlanPolicy = Schema.Struct({
  /**
   * `release`: the rules every production plan obeys. `code-only`: only PoolWorker code moves.
   * `cutover-classes`: the non-noop set equals the reviewed allow-list.
   */
  mode: Schema.Literals(["release", "code-only", "cutover-classes"]),
  /** A type ending in `*` matches by prefix. */
  protected: Schema.Struct({ fqns: Schema.Array(exactFqn), types: Schema.Array(Schema.String) }),
  /** Every delete, orphan or replace a reviewer accepted. Protected resources cannot be listed away. */
  removals: Schema.Array(
    Schema.Struct({
      fqn: exactFqn,
      type: Schema.String,
      action: Schema.Literals(["delete", "orphaned", "replace"]),
      reason: Schema.String,
    }),
  ),
  poolContainer: Schema.Struct({
    fqn: exactFqn,
    /** The registry digest reference the legacy root runs; supplied by the caller, never committed. */
    image: Schema.String.check(Schema.isPattern(digestRef)),
    /**
     * Only an image release of the root declares this. Every other release must leave the root's row
     * as it is, not even its recorded hash: a rollout moves the application's version, and the
     * pool's own restart then refuses for good.
     */
    imageRelease: Schema.optional(Schema.Literal(true)),
    /**
     * The healing release only: the root's row may plan an update whose only difference is its
     * recorded image hash. The old release layer recorded the build's input there, while a pinned
     * declaration hashes the reference, so the first release through this entry plans the row
     * although nothing about the application changes. Every other difference still refuses, and
     * the wire guard refuses any modify or rollout of the root whatever the plan says.
     */
    recordedHashOnly: Schema.optional(Schema.Literal(true)),
    /**
     * The root's attachment may plan as not known yet while the pool Worker updates: one of the
     * Worker's settings waits on a row that runs in the same plan, so the planner promises only its
     * id and name. Admitted only when the namespace it resolves to is already recorded, equal on
     * both rows, and the pool Worker still hosts the class; the apply then reads and sends nothing.
     */
    workerAttachment: Schema.optional(Schema.Literal(true)),
    /** The pin's build input, supplied by the caller with the image: what the root really runs. */
    input: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u))),
  }),
  poolWorker: exactFqn,
  artifactsCredentials: exactFqn,
  /** `cutover-classes` only: every non-noop node, with its action. */
  allow: Schema.Array(
    Schema.Struct({
      fqn: exactFqn,
      action: Schema.String,
      /**
       * Admitted only while every property that differs is not known yet: a connection whose origin
       * waits on a database command's hash. A resolved difference, such as another database, refuses.
       */
      unresolvedOnly: Schema.optional(Schema.Literal(true)),
      /**
       * Admitted only as a change of the Worker's code. Nothing else of the row may differ, except:
       * - `main`, while it names the same file of another checkout: a declaration names its entry
       *   by an absolute path, so the directory a release job runs in is part of the value;
       * - a `references` entry of `env`, which holds another resource. The plan either still
       *   waits on the named resource alone, while it updates, or holds the attributes State
       *   records for it now. While it waits, the entry's binding waits too. Both have to be the
       *   resource State held there: what an update cannot change of it (its id, its name) is
       *   known in the plan and must equal the recorded value, in the entry and in its binding;
       * - the named `fields` of a `values` entry of `env`, a record as plain or redacted JSON,
       *   for the reason written beside it. Everything else in that record, a credential
       *   included, must be as recorded, in the entry and in the value its binding carries.
       * A changed secret or value, an entry or binding added or removed, an entry moved to
       * another resource and a changed class all refuse. Its classes and migrations follow from
       * its bindings; the wire guard holds the upload to the serving version's bindings
       * (`wire.fixedBindings`) and refuses any migration.
       */
      codeOnly: Schema.optional(
        Schema.Struct({
          references: Schema.Array(Schema.Struct({ name: settingName, resource: exactFqn })),
          values: Schema.Array(
            Schema.Struct({
              name: settingName,
              fields: Schema.NonEmptyArray(settingName),
              why: reason,
            }),
          ),
          why: reason,
        }),
      ),
    }),
  ),
  /** `code-only`: when set, only these commands may run; any other Command row refuses. */
  commands: Schema.optional(Schema.Array(exactFqn)),
  /** Present exactly when the plan is filtered: the FQNs handed to `include`. */
  include: Schema.optional(Schema.Array(exactFqn)),
});
export type PlanPolicy = typeof PlanPolicy.Type;

export const decodePlanPolicy = Schema.decodeUnknownEffect(PlanPolicy, {
  onExcessProperty: "error",
});

export interface PlanChange {
  readonly fqn: string;
  readonly type: string;
  readonly action: string;
  readonly bindings: readonly { readonly sid: string; readonly action: string }[];
}

export interface PlanViolation {
  readonly rule: string;
  readonly fqn: string;
  readonly type: string;
  readonly action: string;
  /** Each entry is `path: old -> new`, with secrets and free text withheld. */
  readonly change: readonly string[];
  readonly why: string;
  readonly fix: string;
}

export class PlanRefused extends Data.TaggedError("PlanRefused")<{
  readonly violations: readonly PlanViolation[];
}> {
  override get message() {
    return [
      `The plan was refused: ${this.violations.length} violation(s). Nothing was applied.`,
      ...this.violations.map(
        (v) =>
          `- [${v.rule}] ${v.fqn} (${v.type}) ${v.action}\n` +
          v.change.map((line) => `    ${line}\n`).join("") +
          `    why: ${v.why}\n    fix: ${v.fix}`,
      ),
    ].join("\n");
  }
}

type Node = Plan.CRUD;
const workerType = "Cloudflare.Worker";
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Class, binding and resource names are structure, not data. Everything else must earn its place. */
const structural = (value: unknown) =>
  value === undefined
    ? "absent"
    : typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,99}$/u.test(value)
      ? value
      : !isResolved(value)
        ? "<unresolved>"
        : "<withheld>";
const privatePath = /env|secret|token|key|password|credential|url|dsn|authorization|cookie/iu;
/** A plan is printed into a public log: a value is shown only when its form cannot hold a secret. */
function shown(value: unknown, path: readonly string[]): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Redacted.isRedacted(value)) return "<redacted>";
  if (!isResolved(value)) return "<unresolved>";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value !== "string") return "<changed>";
  const field = path.at(-1) ?? "";
  if (/hash|digest/iu.test(field) && /^(?:sha256:)?[a-f0-9]{16,64}$/u.test(value)) return value;
  // An image reference names an account in its path; the repository and digest identify it.
  if (/^image$/iu.test(field) && /^[a-z0-9.-]+\/[a-z0-9/_-]+[@:][A-Za-z0-9:._-]+$/u.test(value))
    return `…/${value.slice(value.lastIndexOf("/") + 1)}`;
  if (path.some((key) => privatePath.test(key))) return "<withheld>";
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u.test(value) && !/^[A-Fa-f0-9]{24,}$/u.test(value)
    ? value
    : "<withheld>";
}

/** Each leaf that differs, as `path: old -> new` with values shown only when safe to print. */
export function propChanges(
  old: unknown,
  next: unknown,
  path: readonly string[] = ["props"],
  depth = 16,
): string[] {
  if (Object.is(old, next)) return [];
  // An applied plan's props can point back at themselves; past this depth a leaf is just changed.
  if (path.length > depth) return [`${path.join(".")}: changed`];
  if (
    (record(old) || old === undefined) &&
    (record(next) || next === undefined) &&
    !Redacted.isRedacted(old) &&
    !Redacted.isRedacted(next) &&
    isResolved(old) &&
    isResolved(next)
  ) {
    const keys = [...new Set([...Object.keys(old ?? {}), ...Object.keys(next ?? {})])].sort();
    return keys.flatMap((key) => propChanges(old?.[key], next?.[key], [...path, key], depth));
  }
  if (Array.isArray(old) && Array.isArray(next) && isResolved(old) && isResolved(next))
    return Array.from({ length: Math.max(old.length, next.length) }, (_, index) =>
      propChanges(old[index], next[index], [...path, String(index)], depth),
    ).flat();
  if (!havePropsChanged({ value: old }, { value: next })) return [];
  return [`${path.join(".")}: ${shown(old, path)} -> ${shown(next, path)}`];
}

/** The checkout this check runs from: the stack's declarations name their files under it. */
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const filePath = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("file:")) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return undefined;
  }
};
/**
 * Whether a recorded entry file is the declared one under another checkout's directory. Both are
 * absolute, as a path or a file URL; the declared one has to sit in this checkout, and the
 * recorded one has to end with the same path from its own checkout's root.
 */
export function sameEntryFile(old: unknown, next: unknown, root = checkout): boolean {
  const before = filePath(old);
  const after = filePath(next);
  if (before === undefined || after === undefined || !isAbsolute(before)) return false;
  const inside = relative(root, after);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return false;
  return before === after || before.endsWith(`${sep}${inside}`);
}
/** An entry file for a public log: its file and directory name, never where the checkout sits. */
const entryName = (value: unknown) => {
  const names = (filePath(value) ?? "").split(sep).slice(-2);
  return names.length === 2 && names.every((name) => /^[A-Za-z0-9._-]{1,80}$/u.test(name))
    ? `…/${names.join("/")}`
    : "<withheld>";
};

/** An interrupted update keeps the last settled generation under `old`. */
const recorded = (node: Node) =>
  node.state?.status === "updating" && node.state.old ? node.state.old : node.state;
const recordedBindings = (node: Node): readonly { sid: string; data: unknown }[] => {
  const state = recorded(node);
  return state && "bindings" in state && Array.isArray(state.bindings) ? state.bindings : [];
};
/**
 * A row's binding changes against its last finished generation. For a row an interrupted apply left
 * `updating`, Alchemy compares bindings with the unfinished generation (alchemy/src/Plan.ts), so a
 * change that apply had already written plans as noop, and a binding it had dropped plans no row.
 */
const bindingChanges = (node: Node): Node["bindings"] => {
  if (!(node.state?.status === "updating" && node.state.old)) return node.bindings;
  const finished = new Map(recordedBindings(node).map((binding) => [binding.sid, binding.data]));
  const rows: Node["bindings"][number][] = node.bindings.map((binding) =>
    binding.action === "delete"
      ? binding
      : !finished.has(binding.sid)
        ? { ...binding, action: "create" }
        : binding.action === "noop" &&
            (!isResolved(binding.data) ||
              propChanges(finished.get(binding.sid), binding.data).length > 0)
          ? { ...binding, action: "update" }
          : binding,
  );
  for (const [sid, data] of finished)
    if (!node.bindings.some((binding) => binding.sid === sid))
      rows.push({ sid, action: "delete", data } as Node["bindings"][number]);
  return rows;
};

interface WireBinding {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly className?: unknown;
  readonly scriptName?: unknown;
  readonly transferredFrom?: unknown;
}
/** A Worker binding row carries the wire bindings of one `env` entry under `data.bindings`. */
const wire = (data: unknown): WireBinding[] =>
  record(data) && Array.isArray(data.bindings) ? data.bindings.filter(record) : [];
const durable = (binding: WireBinding) => binding.type === "durable_object_namespace";
const local = (binding: WireBinding) => durable(binding) && binding.scriptName === undefined;
/**
 * Whether the Worker's last apply recorded a namespace of this class on it: Alchemy writes
 * `durableObjectNamespaces` from Cloudflare's own read-back of the script after each upload.
 */
const hosted = (node: Node, className: unknown) => {
  const attr = (recorded(node) as { attr?: unknown } | undefined)?.attr;
  const namespaces =
    record(attr) && record(attr.durableObjectNamespaces) ? attr.durableObjectNamespaces : {};
  const id = typeof className === "string" ? namespaces[className] : undefined;
  return typeof id === "string" && id.length > 0;
};

function workerViolations(node: Node, policy: PlanPolicy): PlanViolation[] {
  const at = { fqn: node.resource.FQN, type: node.resource.Type, action: node.action };
  const old = new Map(recordedBindings(node).map((binding) => [binding.sid, binding.data]));
  const violations: PlanViolation[] = [];
  const removed = (sid: string, binding: WireBinding) =>
    violations.push({
      ...at,
      rule: local(binding) ? "durable-object-class-removed" : "worker-binding-removed",
      change: [
        `bindings.${sid}: ${structural(binding.type)} ${structural(binding.name)}` +
          (durable(binding) ? ` class ${structural(binding.className)}` : "") +
          " -> absent",
      ],
      why: local(binding)
        ? `Removing the binding makes Alchemy upload deleted_classes for ${structural(binding.className)}, which deletes every object of that class and its storage. That cannot be undone.`
        : "A release never removes a Worker binding: the running code may still read it, and a cross-script Durable Object binding is the only handle on another Worker's stored objects.",
      fix: "Restore the binding in the Worker's declaration. Retiring a binding or a class is its own reviewed change, never part of a release.",
    });
  for (const binding of bindingChanges(node)) {
    const next = wire(binding.data);
    if (binding.action === "delete") {
      for (const entry of next) removed(binding.sid, entry);
      if (!next.length)
        violations.push({
          ...at,
          rule: "worker-binding-removed",
          change: [`bindings.${binding.sid}: present -> absent`],
          why: "A release never removes a Worker binding: the running code may still read it.",
          fix: "Restore the binding in the Worker's declaration.",
        });
      continue;
    }
    if (binding.action === "create" && policy.mode === "code-only")
      violations.push({
        ...at,
        rule: "code-only-binding-change",
        change: next.map(
          (entry) =>
            `bindings.${binding.sid}: absent -> ${structural(entry.type)} ${structural(entry.name)}`,
        ),
        why: "A code-only release must stay reversible with a Worker rollback; a new binding changes what the Worker is attached to.",
        fix: "Ship the binding in its own release, or run this plan in release mode after review.",
      });
    for (const entry of next)
      if (
        durable(entry) &&
        entry.transferredFrom !== undefined &&
        !(Array.isArray(entry.transferredFrom) && entry.transferredFrom.length === 0) &&
        // Alchemy ships a transfer only for a class new to this Worker. Once State records the
        // class's namespace here, the move is done and the declaration is inert history.
        !hosted(node, entry.className)
      )
        violations.push({
          ...at,
          rule: "durable-object-class-transferred",
          change: [
            `bindings.${binding.sid}.transferredFrom: declared for class ${structural(entry.className)}, and State records no namespace of it on this Worker`,
          ],
          why: "For a class new to this Worker, transferredFrom makes Alchemy upload transferred_classes when a listed former host still holds it, which moves every object of the class here.",
          fix: "Moving a class between Workers is its own reviewed change. If the class already lives on this Worker, its State row is missing the namespace: settle that first.",
        });
    if (binding.action !== "update") continue;
    // A binding whose value waits on another row (a command's hash, a build's output) is not
    // known yet: it keeps its sid and gets its data at apply. Only a `delete` removes it, and a
    // class it hosted is still refused at the wire as `deleted_classes`.
    if (!isResolved(binding.data)) continue;
    const before = wire(old.get(binding.sid));
    for (const entry of before) {
      const same = next.find((candidate) => candidate.name === entry.name);
      if (!same || (durable(entry) && !durable(same))) {
        removed(binding.sid, entry);
        continue;
      }
      if (!durable(entry)) continue;
      const fields = (["className", "scriptName"] as const).filter(
        (field) =>
          entry[field] !== same[field] &&
          // An unresolved name is a value Alchemy fills in at apply; it is not a declared change.
          isResolved(entry[field]) &&
          isResolved(same[field]),
      );
      if (fields.length)
        violations.push({
          ...at,
          rule: "durable-object-class-changed",
          change: fields.map(
            (field) =>
              `bindings.${binding.sid}.${field}: ${structural(entry[field])} -> ${structural(same[field])}`,
          ),
          why: `The binding ${structural(entry.name)} would point at a different class. The old class ${structural(entry.className)} is then no longer bound, and Alchemy uploads deleted_classes for it.`,
          fix: "Keep className and scriptName as recorded. Renaming a class is its own reviewed change.",
        });
    }
  }
  return violations;
}

/**
 * Whether the root's planned update is one the apply settles with reads only, explained by one or
 * both of: the image hash the old release layer recorded (a pinned declaration hashes the reference
 * instead), and an attachment the plan cannot know while the pool Worker updates.
 */
export function rootUpdateSettles(
  node: Node,
  policy: PlanPolicy,
  referenceHash: string | undefined,
  worker: { readonly node: Node | undefined; readonly clean: boolean },
): boolean {
  const props: Record<string, unknown> = record(node.resource.Props) ? node.resource.Props : {};
  const before = recorded(node)?.props;
  const built = ["context", "dockerfile", "main"].filter((key) => props[key] !== undefined);
  // A root update the apply settles with reads only, explained by one or both of: the image hash
  // the old release layer recorded (a pinned declaration hashes the reference instead), and an
  // attachment the plan cannot know while the pool Worker updates. Anything else stays refused.
  const recordedHash = (recorded(node) as { attr?: { hash?: { image?: unknown } } } | undefined)
    ?.attr?.hash?.image;
  const hashDiffers =
    typeof recordedHash === "string" &&
    referenceHash !== undefined &&
    recordedHash !== referenceHash;
  const pending = bindingChanges(node).filter((binding) => binding.action !== "noop");
  const className = props.className;
  const attachmentWaitsOnWorker = () => {
    const [binding] = pending;
    if (pending.length !== 1 || !binding || binding.action !== "update") return false;
    // Not known yet, and waiting on the pool Worker alone.
    if (isResolved(binding.data)) return false;
    const upstream = Object.keys(Output.upstreamAny(binding.data));
    if (upstream.length !== 1 || upstream[0] !== policy.poolWorker) return false;
    const recordedData = recordedBindings(node).find((entry) => entry.sid === binding.sid)?.data;
    // The provider writes exactly the namespace here. A comparison stops at data holding an
    // unknown, so any value beside it, on either row, could differ unseen.
    const onlyNamespace = (data: unknown) =>
      record(data) &&
      Object.keys(data).join() === "durableObjects" &&
      record(data.durableObjects) &&
      Object.keys(data.durableObjects).join() === "namespaceId";
    if (!onlyNamespace(binding.data) || !onlyNamespace(recordedData)) return false;
    // What it will resolve to is already recorded, the same on both rows: a namespace id is
    // permanent for a Worker and a class, so the Worker's update cannot move it.
    const attached =
      record(recordedData) && record(recordedData.durableObjects)
        ? recordedData.durableObjects.namespaceId
        : undefined;
    if (typeof attached !== "string" || attached.length === 0) return false;
    const rootAttr = (recorded(node) as { attr?: { durableObjects?: { namespaceId?: unknown } } })
      ?.attr;
    if (rootAttr?.durableObjects?.namespaceId !== attached) return false;
    const workerNode = worker.node;
    if (!workerNode || typeof className !== "string") return false;
    const workerAttr = (
      recorded(workerNode) as { attr?: { durableObjectNamespaces?: Record<string, unknown> } }
    )?.attr;
    if (workerAttr?.durableObjectNamespaces?.[className] !== attached) return false;
    // The pool Worker updates, nothing its own rules refuse, and still hosts the class itself.
    return (
      workerNode.action === "update" &&
      worker.clean &&
      bindingChanges(workerNode).some(
        (entry) =>
          entry.action !== "delete" &&
          wire(entry.data).some(
            (bound) =>
              durable(bound) && bound.className === className && bound.scriptName === undefined,
          ),
      )
    );
  };
  return (
    node.action === "update" &&
    propChanges(before, props).length === 0 &&
    !built.length &&
    props.image === policy.poolContainer.image &&
    (hashDiffers || pending.length > 0) &&
    (!hashDiffers || policy.poolContainer.recordedHashOnly === true) &&
    (pending.length === 0 ||
      (policy.poolContainer.workerAttachment === true && attachmentWaitsOnWorker()))
  );
}

function containerViolations(
  node: Node,
  policy: PlanPolicy,
  /** The hash Alchemy gives the declared image reference (`ContainerProvider`, a pre-built image). */
  referenceHash: string | undefined,
  /** The pool Worker's node in the same plan, and whether its own rules refused nothing. */
  worker: { readonly node: Node | undefined; readonly clean: boolean },
): PlanViolation[] {
  const at = { fqn: node.resource.FQN, type: node.resource.Type, action: node.action };
  const props: Record<string, unknown> = record(node.resource.Props) ? node.resource.Props : {};
  const before = recorded(node)?.props;
  const violations: PlanViolation[] = [];
  const fix =
    "Declare the root container with `image:` set to the pinned digest reference and no build inputs, as recorded in State.";
  const built = ["context", "dockerfile", "main"].filter((key) => props[key] !== undefined);
  if (built.length)
    violations.push({
      ...at,
      rule: "pool-container-built-from-source",
      change: built.map((key) => `props.${key}: absent -> declared`),
      why: "A build input makes Alchemy build and publish a new image, which rolls the legacy root and boots a new Home on production data.",
      fix,
    });
  if (props.image !== policy.poolContainer.image)
    violations.push({
      ...at,
      rule: "pool-container-image-not-pinned",
      change: [
        `props.image: ${shown(policy.poolContainer.image, ["image"])} (pin) -> ${shown(props.image, ["image"])}`,
      ],
      why: "The legacy root must keep running the pinned image until it is retired.",
      fix,
    });
  if (node.action !== "noop" && node.action !== "update")
    violations.push({
      ...at,
      rule: "pool-container-lifecycle",
      change: [`$resource: recorded -> ${node.action}`],
      why: "The root container holds the pool's Durable Object storage; only a hash-only update of its recorded row is safe.",
      fix: "Check that State still holds the root container's row and that the declaration matches it.",
    });
  const changed = propChanges(before, props);
  if (changed.length && !built.length && props.image === policy.poolContainer.image)
    violations.push({
      ...at,
      rule: "pool-container-configuration-change",
      change: changed,
      why: "Any change besides the image hash makes Alchemy patch the application, which starts a rollout of the legacy root.",
      fix: "Make the declaration equal to the recorded props, or change the root in its own reviewed release.",
    });
  // The pool's own restart refuses for good once the application's version or settings move, so
  // a release that relies on it may not touch the root's row in any way.
  const settles = rootUpdateSettles(node, policy, referenceHash, worker);
  if (!policy.poolContainer.imageRelease && !settles && node.action !== "noop")
    violations.push({
      ...at,
      rule: "pool-container-not-noop",
      change: [
        `$action: noop -> ${node.action}`,
        ...propChanges(before, props),
        ...bindingChanges(node)
          .filter((binding) => binding.action !== "noop")
          .map((binding) => `bindings.${binding.sid}: ${binding.action}`),
      ],
      why: "Only an image release of the root may plan a row on it. The pool's own restart refuses for good once the root application's version or settings differ from its stored proof, and an applied row can roll the application; even a hash-only update is a row the plan cannot prove harmless.",
      fix: "Find why the root's row plans as changed (the planned reasons name it) and settle it in its own reviewed step before this release.",
    });
  const recordedAttachments = new Map(
    recordedBindings(node).map((binding) => [binding.sid, binding.data]),
  );
  for (const binding of bindingChanges(node)) {
    if (binding.action === "noop") continue;
    // A value unknown until another row resolves, or none at all, is not a planned change: the plan
    // cannot see it, and the wire guard refuses any PATCH or rollout of the root it would cause.
    const changes =
      binding.action === "update"
        ? propChanges(recordedAttachments.get(binding.sid), binding.data, [
            "bindings",
            binding.sid,
          ]).filter((line) => !line.includes("<unresolved>"))
        : [];
    if (binding.action === "update" && changes.length === 0) continue;
    violations.push({
      ...at,
      rule: "pool-container-attachment-change",
      change:
        binding.action === "create" || binding.action === "delete"
          ? [
              `bindings.${binding.sid}: ${binding.action === "create" ? "absent -> present" : "present -> absent"}`,
            ]
          : changes,
      // The root's own restart proof records the application's version and settings digest; it
      // refuses for good once either moves, and only a stopped container can be restarted.
      why:
        binding.action === "update"
          ? "A changed attachment makes Alchemy patch the root application, which moves its version: the pool's own restart then refuses for good, and the root cannot be restarted by any path."
          : "The binding attaches the application to its Durable Object namespace; changing it makes Alchemy recreate the application.",
      fix: "Keep the Worker binding that attaches the root container exactly as recorded; find why it plans as changed (the reasons print the paths) before any release.",
    });
  }
  return violations;
}

const protectedBy = (node: Node, policy: PlanPolicy) =>
  policy.protected.fqns.includes(node.resource.FQN) ||
  policy.protected.types.some((type) =>
    type.endsWith("*")
      ? node.resource.Type.startsWith(type.slice(0, -1))
      : type === node.resource.Type,
  );

const lifecycleChange = (node: Node): string[] => {
  if (node.action !== "replace")
    return [
      `$resource: recorded (${(recorded(node) as { removalPolicy?: string } | undefined)?.removalPolicy ?? "destroy"}) -> ${node.action}`,
    ];
  // The provider names no field when it answers `replace`; every changed prop is a candidate.
  const props = propChanges(recorded(node)?.props, node.resource.Props);
  return [
    `$resource: recorded -> replaced by a new one (${node.deleteFirst ? "the recorded one is deleted first" : "created, then the recorded one is deleted"})`,
    ...(props.length
      ? props
      : ["props: unchanged (a provider mode switch or an unresolved value forced it)"]),
  ];
};
/**
 * The non-noop changes of an admitted plan, for the step summary. A refused plan fails with one
 * error that lists every violation, so a single run shows everything a reviewer has to resolve.
 */
/** The hash Alchemy gives the root's declared image reference: `sha256Object({ image, imageName })`. */
const rootReferenceHash = (plan: Plan.Plan, policy: PlanPolicy) => {
  const props = plan.resources[policy.poolContainer.fqn]?.resource.Props;
  const image = record(props) && typeof props.image === "string" ? props.image : undefined;
  return image === undefined
    ? Effect.succeed(undefined)
    : sha256Object({ image, imageName: undefined }).pipe(Effect.map((hash) => hash.slice(0, 16)));
};

export const checkPlan = (
  plan: Plan.Plan,
  policy: PlanPolicy,
): Effect.Effect<readonly PlanChange[], PlanRefused> =>
  Effect.flatMap(rootReferenceHash(plan, policy), (referenceHash) =>
    Effect.suspend(() => {
      const violations: PlanViolation[] = [];
      const nodes: Node[] = [
        ...Object.values(plan.resources),
        ...Object.values(plan.deletions).filter((node) => node !== undefined),
      ];
      const whole = { fqn: "(plan)", type: "Alchemy.Plan", action: "plan" };

      if (plan.destroy)
        violations.push({
          ...whole,
          rule: "destroy-plan",
          change: ["$plan: deploy -> destroy"],
          why: "A destroy plan deletes every resource of the stage.",
          fix: "Build the plan with the deploy entry point.",
        });
      const include = policy.include;
      if (plan.selectedFqns && !include)
        violations.push({
          ...whole,
          rule: "filtered-plan-without-include",
          change: [`$selection: full -> ${plan.selectedFqns.size} selected`],
          why: "A filtered plan skips the orphan pass and every unselected resource, so it is admitted only for a reviewed selection.",
          fix: "Add the `include` list to the policy, or plan the whole stack.",
        });
      if (include && !plan.selectedFqns)
        violations.push({
          ...whole,
          rule: "full-plan-with-include",
          change: [`$selection: ${include.join(", ")} -> full`],
          why: "The policy was reviewed for a filtered plan; a full plan also reconciles every other resource and runs the orphan pass.",
          fix: "Pass the policy's `include` list to the plan, or review a policy for the full stack.",
        });
      for (const fqn of include ?? [])
        if (plan.selectedFqns && !plan.selectedFqns.has(fqn))
          violations.push({
            ...whole,
            fqn,
            rule: "include-not-selected",
            change: [`$selection.${fqn}: selected -> absent`],
            why: "The plan was built with a different selection than the reviewed one.",
            fix: "Pass exactly the policy's `include` list to the plan.",
          });

      // The pool Worker as the root's rules see it, and whether the root's row settles with reads.
      const poolWorkerNode = nodes.find(
        (candidate) => candidate.resource.FQN === policy.poolWorker,
      );
      const workerContext = {
        node: poolWorkerNode,
        clean: !!poolWorkerNode && workerViolations(poolWorkerNode, policy).length === 0,
      };
      const rootNode = nodes.find(
        (candidate) => candidate.resource.FQN === policy.poolContainer.fqn,
      );
      const rootSettled =
        !!rootNode && rootUpdateSettles(rootNode, policy, referenceHash, workerContext);
      // A root recorded by id but not by name makes the wire guard refuse every container
      // application write of the run, so a plan that writes one would pass here and stop at its
      // first write. A root not recorded yet is the guard's own case: it requires none there.
      const rootAttr = rootNode
        ? (
            recorded(rootNode) as
              | { attr?: { applicationId?: unknown; applicationName?: unknown } }
              | undefined
          )?.attr
        : undefined;
      const present = (value: unknown) => typeof value === "string" && value.length > 0;
      const containerWrite = nodes.find(
        (node) =>
          node.resource.Type === "Cloudflare.Container" &&
          node.resource.FQN !== policy.poolContainer.fqn &&
          node.action !== "noop",
      );
      if (containerWrite && present(rootAttr?.applicationId) && !present(rootAttr?.applicationName))
        violations.push({
          fqn: containerWrite.resource.FQN,
          type: containerWrite.resource.Type,
          action: containerWrite.action,
          rule: "root-name-unrecorded",
          change: [`${policy.poolContainer.fqn}.attr.applicationName: absent`],
          why: "The root's State row records no application name, so the wire guard refuses every container application write in this run, and this plan's apply would stop at its first.",
          fix: "Record the root's application name on its State row before a release that writes a container application.",
        });
      for (const node of nodes) {
        const at = { fqn: node.resource.FQN, type: node.resource.Type, action: node.action };
        const destroys =
          node.action === "delete" || node.action === "orphaned" || node.action === "replace";
        const reviewed = policy.removals.some(
          (removal) =>
            removal.fqn === at.fqn && removal.type === at.type && removal.action === at.action,
        );
        if (destroys && protectedBy(node, policy))
          violations.push({
            ...at,
            rule: "protected-resource-destroyed",
            change: lifecycleChange(node),
            why:
              node.action === "orphaned"
                ? "Alchemy would drop the row and leave the resource live but unmanaged; every reference to it then fails, and nothing guards it afterwards."
                : "The resource holds data that no release may delete or recreate.",
            fix: "Restore the resource's declaration exactly as recorded. A protected resource cannot be listed in `removals`.",
          });
        else if (node.action === "replace" && !reviewed)
          violations.push({
            ...at,
            rule: "unreviewed-replace",
            change: lifecycleChange(node),
            why: "Alchemy would create a new resource and delete the recorded one: whatever it holds is gone, and every binding moves to the empty new one.",
            fix: 'Make the declaration equal to the recorded props, or add this exact fqn, type and action "replace" to the policy\'s `removals` after review.',
          });
        else if (
          (node.action === "delete" || node.action === "orphaned") &&
          // A Command has no cloud resource: its delete only drops the row.
          !(node.action === "delete" && node.resource.Type.startsWith("Command.")) &&
          !reviewed
        )
          violations.push({
            ...at,
            rule: "unreviewed-removal",
            change: lifecycleChange(node),
            why:
              node.action === "orphaned"
                ? "State holds a retained row that the stack no longer declares; Alchemy would drop the row and leave the resource live but unmanaged."
                : "State holds a row that the stack no longer declares; Alchemy would delete the resource.",
            fix: "Declare the resource again, or add this exact fqn, type and action to the policy's `removals` after review.",
          });
        if ("renamedFrom" in node && node.renamedFrom?.length)
          violations.push({
            ...at,
            rule: "resource-renamed",
            change: [`$fqn: ${node.renamedFrom.join(", ")} -> ${at.fqn}`],
            why: "A rename moves the State row before any lifecycle runs; a failed apply then leaves the resource under two identities.",
            fix: "Remove renamedFrom. Renames ship alone, as a full deployment.",
          });
        if (node.resource.Type === workerType) violations.push(...workerViolations(node, policy));
        if (at.fqn === policy.poolContainer.fqn && !destroys)
          violations.push(...containerViolations(node, policy, referenceHash, workerContext));
      }
      for (const [fqn, node] of Object.entries(plan.actionDeletions))
        if (node && !policy.removals.some((r) => r.fqn === fqn && r.action === "delete"))
          violations.push({
            fqn,
            type: node.def.Type,
            action: "delete",
            rule: "unreviewed-removal",
            change: ["$action: recorded -> delete"],
            why: "State holds an action row that the stack no longer declares.",
            fix: "Declare the action again, or add it to the policy's `removals` after review.",
          });

      const changes: PlanChange[] = [
        ...nodes
          .filter((node) => node.action !== "noop")
          .map((node) => ({
            fqn: node.resource.FQN,
            type: node.resource.Type,
            action: node.action,
            bindings: bindingChanges(node)
              .filter((binding) => binding.action !== "noop")
              .map(({ sid, action }) => ({ sid, action })),
          })),
        ...[...Object.values(plan.actions), ...Object.values(plan.actionDeletions)]
          .filter((node) => node !== undefined && node.action !== "noop")
          .map((node) => ({
            fqn: node.def.FQN,
            type: node.def.Type,
            action: node.action,
            bindings: [],
          })),
      ].sort((a, b) => (a.fqn < b.fqn ? -1 : a.fqn > b.fqn ? 1 : 0));

      const outside = (change: PlanChange, expected: string, why: string, fix: string) =>
        violations.push({
          fqn: change.fqn,
          type: change.type,
          action: change.action,
          rule: `outside-${policy.mode}`,
          change: [`$action: ${expected} -> ${change.action}`],
          why,
          fix,
        });
      // Every property that differs on this row is still unknown at plan time.
      const onlyUnresolved = (fqn: string) => {
        const node = nodes.find((candidate) => candidate.resource.FQN === fqn);
        if (!node || !("props" in node)) return false;
        const differences = propChanges(recorded(node)?.props, node.props);
        return (
          differences.length > 0 &&
          differences.every((line) => line.includes("<unresolved>")) &&
          bindingChanges(node).every((binding) => binding.action === "noop")
        );
      };
      // Readiness after the upload refuses a root whose recorded input differs from what the pool
      // Worker expects. A pinned root runs the pin's input, so both identities must name it.
      const pinnedInput = policy.poolContainer.input;
      const poolWorker = nodes.find((candidate) => candidate.resource.FQN === policy.poolWorker);
      if (pinnedInput !== undefined && poolWorker) {
        const declared = record(poolWorker.resource.Props) ? poolWorker.resource.Props : {};
        const env = record(declared.env) ? declared.env : {};
        const differ = ["POOL_IMAGE_HASH", "POOL_DESIRED_IMAGE_INPUT"].filter(
          (key) => env[key] !== pinnedInput,
        );
        if (differ.length)
          violations.push({
            fqn: poolWorker.resource.FQN,
            type: poolWorker.resource.Type,
            action: poolWorker.action,
            rule: "pool-worker-image-input-not-pinned",
            change: differ.map((key) => `env.${key}: differs from the root pin's input`),
            why: "The pool Worker's readiness compares the root's recorded image input with these. The pinned root runs the pin's input, so another value stops the apply after the Worker is uploaded.",
            fix: "Declare POOL_IMAGE_HASH and POOL_DESIRED_IMAGE_INPUT from the root pin's input.",
          });
      }
      // What a code-only allowance does not cover on a row. The rule in one sentence: every
      // property, `env` entry and binding row of the Worker is the same in the plan as in State,
      // in the last finished generation and, after an interrupted apply, in the unfinished one as
      // well, whatever the planner calls the row; either generation may be what is live.
      // The exceptions, each one named:
      // - the entry file may sit under another checkout's directory;
      // - a value the policy names may differ in its named fields;
      // - a reference the policy names may be any copy of its resource's attributes, or the
      //   resource itself while that updates, provided the entry's one binding row holds one wire
      //   entry, named after the entry and as State has it. That row alone may differ in the copy
      //   of a database connection's origin that local development reads; no upload reads it.
      // Each property and each `env` entry is compared on its own: one value that is not known yet
      // must not hide the rest of the row.
      const beyondCode = (
        change: PlanChange,
        codeOnly: NonNullable<PlanPolicy["allow"][number]["codeOnly"]>,
      ) => {
        const node = nodes.find((candidate) => candidate.resource.FQN === change.fqn);
        if (!node || !("props" in node))
          return [
            ...change.bindings.map(({ sid, action }) => `bindings.${sid}: ${action}`),
            "props: not readable",
          ];
        type Row = Node["bindings"][number];
        const values = new Map(codeOnly.values.map((value) => [value.name, value.fields]));
        const references = new Map(
          codeOnly.references.map((entry) => [entry.name, entry.resource]),
        );
        const keys = (...holders: object[]) => [...new Set(holders.flatMap(Object.keys))].sort();
        const planned = (resource: string) =>
          nodes.find((candidate) => candidate.resource.FQN === resource);
        // The generations State holds: the last finished one and, behind an interrupted apply, the
        // unfinished one. The rows below are `noop` only when they are the same in each of them.
        const finished = recorded(node);
        const generations: readonly ({ props?: unknown; bindings?: unknown } | undefined)[] = [
          finished,
          ...(node.state !== finished ? [node.state] : []),
        ];
        const rows = bindingChanges(node);
        /** What each generation holds for a row; `undefined` where one does not hold it. */
        const held = (sid: string): unknown[] =>
          generations.map(
            (generation) =>
              (Array.isArray(generation?.bindings) ? generation.bindings : []).find(
                (binding: { sid?: unknown }) => binding.sid === sid,
              )?.data,
          );
        // A row that is in the plan and in State. A `create` or `delete` row is a change as such.
        const kept = (binding: Row) => binding.action === "noop" || binding.action === "update";

        // A named value is a record, plain or as JSON text, redacted or not. Only its named fields
        // may differ: the rest of it, such as a credential beside a version, is compared.
        const decoded = (value: unknown): Record<string, unknown> | undefined => {
          const text: unknown = Redacted.isRedacted(value) ? Redacted.value(value) : value;
          if (record(text)) return text;
          if (typeof text !== "string") return undefined;
          try {
            const parsed: unknown = JSON.parse(text);
            return record(parsed) ? parsed : undefined;
          } catch {
            return undefined;
          }
        };
        const onlyFields = (old: unknown, next: unknown, fields: readonly string[]) => {
          const before = decoded(old);
          const after = decoded(next);
          const rest = (value: Record<string, unknown>) =>
            Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
          return (
            isResolved(old) &&
            isResolved(next) &&
            Redacted.isRedacted(old) === Redacted.isRedacted(next) &&
            typeof (Redacted.isRedacted(old) ? Redacted.value(old) : old) ===
              typeof (Redacted.isRedacted(next) ? Redacted.value(next) : next) &&
            before !== undefined &&
            after !== undefined &&
            propChanges(rest(before), rest(after)).length === 0
          );
        };
        // A changed value changes its own binding row too. That row is admitted while it is the
        // same binding and the value it carries differs in the named fields only.
        const valueOnly = (binding: Row) => {
          const fields = values.get(binding.sid);
          if (!kept(binding) || fields === undefined || !isResolved(binding.data)) return false;
          const carried = (data: unknown): Record<string, unknown>[] =>
            record(data) && Array.isArray(data.bindings) ? data.bindings.filter(record) : [];
          const rest = (data: unknown) =>
            record(data)
              ? {
                  ...data,
                  bindings: carried(data).map((entry) =>
                    Object.fromEntries(
                      Object.entries(entry).filter(([key]) => key !== "text" && key !== "json"),
                    ),
                  ),
                }
              : data;
          const after = carried(binding.data);
          return held(binding.sid).every((old) => {
            const before = carried(old);
            return (
              propChanges(rest(old), rest(binding.data)).length === 0 &&
              before.length === after.length &&
              after.every((entry, index) =>
                ["text", "json"].every(
                  (key) =>
                    propChanges(before[index]?.[key], entry[key]).length === 0 ||
                    onlyFields(before[index]?.[key], entry[key], fields),
                ),
              )
            );
          });
        };

        // `isResolved` is a type guard, and what it refuses narrows to nothing. Asked this way, a
        // value that is not known yet stays readable.
        const unknownYet = (value: unknown): boolean => !isResolved(value);
        // Not known until one resource applies, and that resource keeps its identity: it updates.
        const waitsOn = (value: unknown, resource: string) =>
          unknownYet(value) &&
          Object.keys(Output.upstreamAny(value)).join("\n") === resource &&
          planned(resource)?.action === "update";
        // A reference's row holds one wire entry, named after the entry. With no wire entry of its
        // name the provider uploads the entry's own value instead: the resource's attributes,
        // which change with every update of the resource and which the plan does not hold.
        const namesEntry = (binding: Row) => {
          const data: unknown = binding.data;
          if (Output.isOutput(data) || !record(data) || !Array.isArray(data.bindings)) return false;
          const [entry, ...more]: unknown[] = data.bindings;
          return more.length === 0 && record(entry) && entry.name === binding.sid;
        };
        // A named reference's row whose upload stays the same: its wire entry is known and as State
        // has it, and so is every other key but one. The copy of a database connection's origin
        // that local development reads may differ, or wait on the named resource alone while that
        // updates.
        const sameBinding = (binding: Row) => {
          const resource = references.get(binding.sid);
          const next: unknown = binding.data;
          return (
            kept(binding) &&
            resource !== undefined &&
            namesEntry(binding) &&
            record(next) &&
            held(binding.sid).every(
              (old) =>
                record(old) &&
                keys(old, next).every((key) =>
                  key === "hyperdrives"
                    ? isResolved(next[key]) || waitsOn(next[key], resource)
                    : isResolved(next[key]) && propChanges(old[key], next[key]).length === 0,
                ),
            )
          );
        };
        // Which resource the upload binds is read from the entry's one binding row, never from
        // the copy of the resource's attributes in the entry: a release that left this Worker
        // alone can have moved those. The value itself is then the named resource: the resource
        // as such while it updates, or the attributes State records for it now.
        const reference = (name: string, old: unknown, next: unknown, resource: string) => {
          const own = rows.filter((binding) => binding.sid === name);
          if (
            !record(old) ||
            Redacted.isRedacted(old) ||
            own.length !== 1 ||
            !own.every((row) => namesEntry(row) && (row.action === "noop" || sameBinding(row)))
          )
            return false;
          if (unknownYet(next)) return Output.isResourceExpr(next) && waitsOn(next, resource);
          const target = planned(resource);
          const attributes = target && (recorded(target) as { attr?: unknown } | undefined)?.attr;
          return record(attributes) && record(next) && propChanges(attributes, next).length === 0;
        };

        const twice = (names: readonly string[]) => [
          ...new Set(names.filter((name, index) => names.indexOf(name) !== index)),
        ];
        const lines = [
          // A policy that names an entry twice, or the Worker itself, would let the looser rule
          // answer for the stricter one.
          ...[codeOnly.references, codeOnly.values].flatMap((list) =>
            twice(list.map((entry) => entry.name)).map((name) => `policy.${name}: named twice`),
          ),
          ...codeOnly.references.flatMap((entry) => [
            ...(values.has(entry.name)
              ? [`policy.${entry.name}: named as a reference and as a value`]
              : []),
            ...(entry.resource === change.fqn
              ? [`policy.${entry.name}: names the Worker itself`]
              : []),
          ]),
          ...rows
            .filter(
              (binding) =>
                binding.action !== "noop" && !valueOnly(binding) && !sameBinding(binding),
            )
            .map(({ sid, action }) => `bindings.${sid}: ${action}`),
        ];
        const after: Record<string, unknown> = record(node.props) ? node.props : {};
        for (const generation of generations) {
          const before: Record<string, unknown> = record(generation?.props) ? generation.props : {};
          for (const prop of keys(before, after)) {
            const old = before[prop];
            const next = after[prop];
            if (prop === "main" && old !== next) {
              if (!sameEntryFile(old, next))
                lines.push(`props.main: ${entryName(old)} -> ${entryName(next)}`);
              continue;
            }
            if (
              prop !== "env" ||
              !record(old) ||
              !record(next) ||
              Redacted.isRedacted(old) ||
              Redacted.isRedacted(next) ||
              Output.isOutput(next)
            ) {
              lines.push(...propChanges(old, next, ["props", prop]));
              continue;
            }
            for (const name of keys(old, next)) {
              const present = Object.hasOwn(old, name) && Object.hasOwn(next, name);
              const fields = values.get(name);
              if (present && fields !== undefined && onlyFields(old[name], next[name], fields))
                continue;
              const changes = propChanges(old[name], next[name], ["props", "env", name]);
              const resource = references.get(name);
              if (!present || resource === undefined) lines.push(...changes);
              else if (!reference(name, old[name], next[name], resource))
                // The value can be the same while its binding row is not the reference's.
                lines.push(
                  ...(changes.length
                    ? changes
                    : [`props.env.${name}: its binding row is not this reference as State has it`]),
                );
            }
          }
        }
        return [...new Set(lines)];
      };
      if (policy.mode === "code-only")
        for (const change of changes) {
          const codeOnly = policy.allow.find(
            (entry) => entry.codeOnly && entry.fqn === change.fqn && entry.action === change.action,
          )?.codeOnly;
          if (codeOnly) {
            const beyond = beyondCode(change, codeOnly);
            if (beyond.length)
              violations.push({
                fqn: change.fqn,
                type: change.type,
                action: change.action,
                rule: "code-only-allowance-exceeded",
                change: beyond,
                why: "This Worker is admitted as a change of its code only. A binding or property change can move its Durable Object classes or what it is attached to, which a Worker rollback does not undo.",
                fix: "Ship that change in its own reviewed release; this policy admits only the Worker's code.",
              });
            continue;
          }
          if (
            // `allow` names what else a reviewer accepted. Otherwise only code moves: an update of any
            // Worker but the bulk-import store's (binding and class changes are refused above), the
            // pinned root's hash, and Command runs such as a migration step (the backup covers those).
            !policy.allow.some(
              (entry) =>
                entry.fqn === change.fqn &&
                entry.action === change.action &&
                (!entry.unresolvedOnly || onlyUnresolved(change.fqn)),
            ) &&
            !(
              change.action === "update" &&
              ((change.type === "Cloudflare.Worker" &&
                change.fqn !== policy.artifactsCredentials) ||
                change.fqn === policy.poolContainer.fqn ||
                (change.type.startsWith("Command.") &&
                  (!policy.commands || policy.commands.includes(change.fqn))))
            )
          )
            outside(
              change,
              "noop",
              "A code-only release moves Worker code (and runs migration steps) and nothing else, so a Worker rollback undoes the code.",
              "Ship this change in its own release, or review a policy in release mode.",
            );
        }
      if (policy.mode === "cutover-classes") {
        const credentials = changes.find((change) => change.fqn === policy.artifactsCredentials);
        if (credentials)
          violations.push({
            ...credentials,
            rule: "artifacts-credentials-not-noop",
            change: [
              `$action: noop -> ${credentials.action}`,
              ...credentials.bindings.map(({ sid, action }) => `bindings.${sid}: ${action}`),
            ],
            why: "Uploading this Worker restarts the Durable Object that holds bulk-import job state, in the same run as a class change that cannot be rolled back.",
            fix: "Ship this Worker's change first, as its own code-only release, then plan the cutover again.",
          });
        for (const change of changes) {
          const allowed = policy.allow.find((entry) => entry.fqn === change.fqn);
          if (
            change.fqn === policy.artifactsCredentials ||
            allowed?.action === change.action ||
            (change.fqn === policy.poolContainer.fqn && rootSettled)
          )
            continue;
          outside(
            change,
            allowed ? allowed.action : "noop",
            "The cutover applies exactly the reviewed set of changes; this one is not in it.",
            "Find out why the plan differs from the reviewed one. Update the allow-list only after review.",
          );
        }
        for (const entry of policy.allow)
          if (!changes.some((change) => change.fqn === entry.fqn))
            violations.push({
              fqn: entry.fqn,
              type: "(not in plan)",
              action: "noop",
              rule: "outside-cutover-classes",
              change: [`$action: ${entry.action} -> noop`],
              why: "The reviewed cutover includes this change, but the plan does not: it is not the plan that was reviewed.",
              fix: "Find out why the plan differs from the reviewed one. Update the allow-list only after review.",
            });
      }
      return violations.length
        ? Effect.fail(new PlanRefused({ violations }))
        : Effect.succeed(changes);
    }),
  );

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const byFqn = <Row extends { fqn: string; action: string }>(rows: readonly Row[]) =>
  [...rows].sort((a, b) =>
    `${a.fqn}\0${a.action}` < `${b.fqn}\0${b.action}`
      ? -1
      : `${a.fqn}\0${a.action}` > `${b.fqn}\0${b.action}`
        ? 1
        : 0,
  );

/**
 * sha256 over Alchemy's own serialisable view of the plan: each row's FQN, type, action, provider
 * mode and binding actions. The view carries no prop or binding values, so nothing secret can
 * reach a log through the digest input, and a changed value that keeps every action is not seen.
 */
export function planDigest(plan: Plan.Plan): string {
  const view = Plan.describePlan(plan);
  return createHash("sha256")
    .update(
      JSON.stringify(canonical({ resources: byFqn(view.resources), actions: byFqn(view.actions) })),
    )
    .digest("hex");
}
