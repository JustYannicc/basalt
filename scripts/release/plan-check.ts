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
import { havePropsChanged, isResolved } from "alchemy/Diff";
import * as Plan from "alchemy/Plan";
import { Data, Effect, Redacted, Schema } from "effect";

const digestRef = /^[a-z0-9.-]+\/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$/u;
const exactFqn = Schema.String.check(Schema.isPattern(/^[^*?\s]+$/u));

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
       * Admitted only as a change of the Worker's code: no binding of the row changes and no
       * property differs, except inside an entry of a named `references` property that both
       * sides hold as a reference to another resource (a Worker it calls moved with the release).
       * An entry's own value, or an entry added or removed, still refuses. Its classes and
       * migrations follow from its bindings; the wire guard holds the upload to the serving
       * version's bindings (`wire.fixedBindings`) and refuses any migration.
       */
      codeOnly: Schema.optional(
        Schema.Struct({ references: Schema.Array(Schema.String), why: Schema.String }),
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

/** An interrupted update keeps the last settled generation under `old`. */
const recorded = (node: Node) =>
  node.state?.status === "updating" && node.state.old ? node.state.old : node.state;
const recordedBindings = (node: Node): readonly { sid: string; data: unknown }[] => {
  const state = recorded(node);
  return state && "bindings" in state && Array.isArray(state.bindings) ? state.bindings : [];
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
  for (const binding of node.bindings) {
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

function containerViolations(node: Node, policy: PlanPolicy): PlanViolation[] {
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
  if (!policy.poolContainer.imageRelease && node.action !== "noop")
    violations.push({
      ...at,
      rule: "pool-container-not-noop",
      change: [
        `$action: noop -> ${node.action}`,
        ...propChanges(before, props),
        ...node.bindings
          .filter((binding) => binding.action !== "noop")
          .map((binding) => `bindings.${binding.sid}: ${binding.action}`),
      ],
      why: "Only an image release of the root may plan a row on it. The pool's own restart refuses for good once the root application's version or settings differ from its stored proof, and an applied row can roll the application; even a hash-only update is a row the plan cannot prove harmless.",
      fix: "Find why the root's row plans as changed (the planned reasons name it) and settle it in its own reviewed step before this release.",
    });
  const recordedAttachments = new Map(
    recordedBindings(node).map((binding) => [binding.sid, binding.data]),
  );
  for (const binding of node.bindings) {
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
export const checkPlan = (
  plan: Plan.Plan,
  policy: PlanPolicy,
): Effect.Effect<readonly PlanChange[], PlanRefused> =>
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
        violations.push(...containerViolations(node, policy));
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
          bindings: node.bindings
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
        node.bindings.every((binding) => binding.action === "noop")
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
    // What a code-only allowance does not cover on a row: a binding that changes, or a property
    // that differs other than inside a reference both sides hold.
    const beyondCode = (change: PlanChange, references: ReadonlyArray<string>) => {
      const node = nodes.find((candidate) => candidate.resource.FQN === change.fqn);
      const lines = change.bindings.map(({ sid, action }) => `bindings.${sid}: ${action}`);
      if (!node || !("props" in node)) return [...lines, "props: not readable"];
      const before = recorded(node)?.props as Record<string, unknown> | undefined;
      const after = node.props as Record<string, unknown> | undefined;
      const entry = (props: Record<string, unknown> | undefined, prop: string, key: string) => {
        const holder = props?.[prop];
        return record(holder) ? holder[key] : undefined;
      };
      for (const line of propChanges(before, after)) {
        const [, prop = "", key = ""] = /^props\.([^.:]+)\.([^.:]+)[.:]/u.exec(line) ?? [];
        const old = entry(before, prop, key);
        const next = entry(after, prop, key);
        // A reference whose target moved: the entry was recorded as an object, and is one again
        // or is not known yet. Its own identity is the binding's, checked above and at the wire.
        if (references.includes(prop) && record(old) && (record(next) || !isResolved(next)))
          continue;
        lines.push(line);
      }
      return lines;
    };
    if (policy.mode === "code-only")
      for (const change of changes) {
        const codeOnly = policy.allow.find(
          (entry) => entry.codeOnly && entry.fqn === change.fqn && entry.action === change.action,
        )?.codeOnly;
        if (codeOnly) {
          const beyond = beyondCode(change, codeOnly.references);
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
            ((change.type === "Cloudflare.Worker" && change.fqn !== policy.artifactsCredentials) ||
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
        if (change.fqn === policy.artifactsCredentials || allowed?.action === change.action)
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
  });

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
