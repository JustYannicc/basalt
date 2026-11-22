/**
 * What a filtered plan's `UnsafeSelectionBoundary` refused, for the public report. Alchemy's planner
 * (alchemy/src/Plan.ts) raises it with a fixed sentence per check that embeds resource FQNs. A
 * message matching exactly one of those sentences, with every name in it a plain resource name,
 * prints the check and those names under the roles the sentence gives them; nothing else from the
 * message prints. Any other message (another Alchemy release's wording, a name that is not plain)
 * gives `undefined`, and the caller keeps its generic line.
 */

/** A resource name from our own source: no spaces, quotes, slashes or hosts. */
const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,120}$/u;
/** Account, zone and namespace ids are hex runs, which a name never holds. */
const HEX_ID = /[A-Fa-f0-9]{16,}/u;
const NAMES_PER_LIST = 8;
const SELECT_OR_FULL = "Select them or run a full deployment\\.";

/**
 * The planner's checks in its order, each with its sentence as a regular expression: `'<role>'` is
 * one quoted name, a bare `<role>` is names joined by ", ".
 */
const CHECKS: ReadonlyArray<readonly [check: string, sentence: string]> = [
  [
    "action-overwrites-state",
    "Filtered Action '<action>' cannot overwrite persisted resource state\\. Finish resource cleanup before reusing its FQN for an Action\\.",
  ],
  [
    "rename-across-selection",
    "Filtered reconciliation cannot migrate '<from>' to '<to>'\\. Run a full deployment for renames\\.",
  ],
  [
    "unselected-dependency",
    "Output evaluation discovered unselected dependency '<dependency>'\\. Declare the dependency explicitly or run a full deployment\\.",
  ],
  [
    "mode-switch-while-deleting",
    "Cannot switch provider mode for '<resource>' during filtered recovery from deleting\\. Finish interrupted destruction in its recorded '[a-z]+' mode before deploying in '[a-z]+' mode; a full mode-switch deployment is not a safe recovery\\.",
  ],
  [
    "detach-with-unselected-consumers",
    `Cannot detach '<source>' from '<consumer>' while downstream consumers are unselected: <unselected>\\. ${SELECT_OR_FULL}`,
  ],
  [
    "replace-with-unproven-history",
    "Cannot replace or collect old generations of '<resource>' while '<unselected>' is unselected\\. (?:Historical binding-cycle dependencies recorded on '<bindingEvidence>'|Historical dependencies missing from '<incompleteHistory>') cannot be proven safe; run a full deployment\\.",
  ],
  [
    "replace-with-unselected-dependents",
    `Cannot replace or collect old generations of '<resource>' while dependents are unselected: <unselected>\\. ${SELECT_OR_FULL}`,
  ],
  [
    "incomplete-downstream-history",
    `Cannot reconcile '<resource>' with incomplete historical downstream metadata while persisted nodes are unselected: <unselected>\\. ${SELECT_OR_FULL}`,
  ],
  [
    "last-binding-evidence",
    `Cannot discard the last historical binding evidence while persisted nodes are unselected: <unselected>\\. ${SELECT_OR_FULL}`,
  ],
];

const TEMPLATES = CHECKS.map(([check, sentence]) => {
  const lists = new Set<string>();
  const source = sentence.replace(/'<(\w+)>'|<(\w+)>/gu, (_, one?: string, several?: string) => {
    if (one) return `'(?<${one}>[^']+)'`;
    lists.add(several ?? "");
    return `(?<${several}>.+)`;
  });
  return { check, pattern: new RegExp(`^${source}$`, "u"), lists };
});

const plain = (name: string) => NAME.test(name) && !HEX_ID.test(name);

/** `UnsafeSelectionBoundary: check=<check> <role>=<names>…`, or `undefined` when not proven. */
export function selectionBoundary(message: string): string | undefined {
  const matches = TEMPLATES.flatMap((template) => {
    const groups = template.pattern.exec(message)?.groups;
    return groups ? [{ ...template, groups }] : [];
  });
  const [match] = matches;
  if (matches.length !== 1 || !match) return undefined;
  const { check, groups, lists } = match;
  const fields = [`check=${check}`];
  for (const [role, value] of Object.entries(groups)) {
    // The other branch of an alternative.
    if (value === undefined) continue;
    const names = lists.has(role) ? value.split(", ") : [value];
    if (!names.every(plain)) return undefined;
    const more = names.length - NAMES_PER_LIST;
    fields.push(
      `${role}=${names.slice(0, NAMES_PER_LIST).join(",")}${more > 0 ? `,+${more} more` : ""}`,
    );
  }
  return `UnsafeSelectionBoundary: ${fields.join(" ")}`;
}
