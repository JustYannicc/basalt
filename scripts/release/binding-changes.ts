import { havePropsChanged } from "alchemy/Diff";
import * as Output from "alchemy/Output";
import type * as AlchemyPlan from "alchemy/Plan";
import { Redacted } from "effect";
import { safeJson } from "./safe-json.ts";

/**
 * Which bindings each updated Worker changes, by name and by the type it is declared as, never by
 * value, and whether, by declared type, a failed release's rollback could force every changed
 * secret past Cloudflare's changed-secret refusal. The declared type is not the authority: the
 * live Worker's is (22 Nov: a value declared plain and also read as configuration stayed plain).
 * The release prints it in plan mode, after the digest, for the person who gives the apply its GO.
 * It only reads the plan: nothing the apply compares depends on it.
 */

/**
 * A name the stack declares: letters, digits and underscores. Anything else is withheld, and so is
 * a long hex run, which may be an id (as in public-report.ts).
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/u;
const HEX_ID = /[A-Fa-f0-9]{16,}/u;
const printable = (name: string) => (NAME.test(name) && !HEX_ID.test(name) ? name : WITHHELD);
/** Cloudflare's binding types are lowercase words; anything else is not printed. */
const TYPE = /^[a-z][a-z0-9_]{0,40}$/u;
const SECRET = "secret_text";
const WITHHELD = "[withheld]";

const changed = (before: unknown, after: unknown) => {
  try {
    // Alchemy's own diff: a stored, provider-normalised value is not a change.
    return havePropsChanged({ value: before }, { value: after });
  } catch {
    return safeJson(before) !== safeJson(after);
  }
};

const isRedacted = (value: unknown) =>
  Redacted.isRedacted(value) ||
  (typeof value === "object" &&
    value !== null &&
    (value as { _tag?: unknown })._tag === "Redacted");

/** The wire types a binding's data declares (`data.bindings[].type`), and nothing else from it. */
const wireTypes = (data: unknown) => {
  const entries = (data as { bindings?: unknown } | undefined)?.bindings;
  if (!Array.isArray(entries)) return [];
  const types = entries.map((entry) => (entry as { type?: unknown } | undefined)?.type);
  return [...new Set(types.filter((type): type is string => typeof type === "string"))]
    .filter((type) => TYPE.test(type))
    .sort();
};

/** A changed value's type from its form alone; its content is never read. */
const typeOf = (before: unknown, after: unknown, wire: readonly string[]) =>
  isRedacted(after) || (after === undefined && isRedacted(before))
    ? SECRET
    : wire.length
      ? wire.join("+")
      : after === undefined
        ? "removed"
        : typeof after === "string"
          ? "plain_text"
          : Output.isExpr(after)
            ? "unresolved"
            : "json";

export interface WorkerBindingChanges {
  readonly worker: string;
  readonly changes: readonly { readonly name: string; readonly type: string }[];
}

/** Every Worker the plan updates, with the names and types of the bindings it changes. */
export function bindingChanges(plan: AlchemyPlan.Plan): WorkerBindingChanges[] {
  const workers: WorkerBindingChanges[] = [];
  for (const fqn of Object.keys(plan.resources).sort()) {
    const node = plan.resources[fqn]!;
    if ((node as { resource?: { Type?: unknown } }).resource?.Type !== "Cloudflare.Worker")
      continue;
    const bindings =
      (node as { bindings?: readonly { sid: string; action: string; data?: unknown }[] })
        .bindings ?? [];
    if (node.action === "noop" && bindings.every((binding) => binding.action === "noop")) continue;
    const before =
      (node.state as { props?: { env?: Record<string, unknown> } } | undefined)?.props?.env ?? {};
    const after =
      ("props" in node ? (node.props as { env?: Record<string, unknown> } | undefined)?.env : {}) ??
      {};
    const wire = new Map(bindings.map((binding) => [binding.sid, wireTypes(binding.data)]));
    const changes = new Map<string, string>();
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
      if (changed(before[name], after[name]))
        changes.set(name, typeOf(before[name], after[name], wire.get(name) ?? []));
    for (const binding of bindings)
      if (binding.action !== "noop" && !changes.has(binding.sid))
        changes.set(binding.sid, (wire.get(binding.sid) ?? []).join("+") || "binding");
    if (!changes.size) continue;
    workers.push({
      worker: printable(fqn),
      changes: [...changes]
        .map(([name, type]) => ({ name: printable(name), type }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return workers;
}

/** The policy's `rollback.forceSecrets`, read without its schema, so it reads any policy. */
export const forceListOf = (policy: unknown): readonly string[] => {
  const list = (policy as { rollback?: { forceSecrets?: unknown } } | undefined)?.rollback
    ?.forceSecrets;
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
};

/** The public lines: each updated Worker's changed bindings, then the verdict on its secrets. */
export function bindingChangesReport(plan: AlchemyPlan.Plan, forceSecrets: readonly string[]) {
  const workers = bindingChanges(plan);
  const listed = new Set(forceSecrets);
  const named = (pick: (type: string, name: string) => boolean) =>
    workers.flatMap(({ worker, changes }) =>
      changes.filter(({ name, type }) => pick(type, name)).map(({ name }) => `${worker}: ${name}`),
    );
  const unlisted = named(
    (type, name) => type.split("+").includes(SECRET) && (name === WITHHELD || !listed.has(name)),
  );
  const unknown = named((type) => type === "unresolved" || type === "binding");
  return [
    "Binding changes per updated Worker (names, and the type each is declared as; the live Worker's types decide):",
    ...(workers.length
      ? workers.map(
          ({ worker, changes }) =>
            `- ${worker}: ${changes.map(({ name, type }) => `${name} (declared ${type})`).join(", ")}`,
        )
      : ["- none"]),
    unlisted.length
      ? `By declared type, every changed secret is on forceSecrets: NO. Not on it: ${unlisted.join("; ")}.`
      : unknown.length
        ? `By declared type, every changed secret is on forceSecrets: not known until the apply resolves ${unknown.join("; ")}.`
        : "By declared type, every changed secret is on forceSecrets: yes.",
  ].join("\n");
}
