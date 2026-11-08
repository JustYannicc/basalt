import { settingsRefusal } from "../release-barrier/script-settings.ts";
import type { Binding } from "./plan.ts";

export interface Change {
  resource: string;
  property: string;
  expected: string | number | null;
  observed: string | number | null;
}
export class UpgradeRefusal extends Error {
  readonly resource: string;
  readonly property: string;
  readonly expected: string | number | null;
  readonly observed: string | number | null;
  readonly changes: Change[];
  constructor(
    resource: string,
    property: string,
    expected: string | number | null,
    observed: string | number | null,
    changes?: Change[],
  ) {
    const all = changes ?? [{ resource, property, expected, observed }];
    super(
      all
        .map(
          (change) =>
            `${change.resource}: ${change.property} expected ${change.expected}, observed ${change.observed}`,
        )
        .join("; "),
    );
    this.resource = resource;
    this.property = property;
    this.expected = expected;
    this.observed = observed;
    this.changes = all;
  }
}
export function differences(resource: string, before: unknown, after: unknown): Change[] {
  return (settingsRefusal("state-store-drift", resource, before, after).delta?.changed ?? []).map(
    (change) => ({
      resource,
      property: change.path,
      expected: "old" in change ? change.old : "redacted",
      observed: "new" in change ? change.new : "redacted",
    }),
  );
}
export function bindingDifferences(before: readonly Binding[], after: readonly Binding[]) {
  const names = [...new Set([...before, ...after].map((binding) => binding.name))].sort();
  return names.flatMap((name) =>
    differences(
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "invalid-binding-name",
      before.find((binding) => binding.name === name),
      after.find((binding) => binding.name === name),
    ),
  );
}
export function refuseChanges(changes: Change[]) {
  const first = changes[0];
  if (first)
    throw new UpgradeRefusal(
      first.resource,
      first.property,
      first.expected,
      first.observed,
      changes,
    );
}
