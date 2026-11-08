import type { ProviderFailure } from "./provider-failure.ts";
import { publicPropPath } from "../release-barrier/prop-diff.ts";
import { digest } from "./encoding.ts";
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
  readonly provider?: ProviderFailure;
  constructor(
    resource: string,
    property: string,
    expected: string | number | null,
    observed: string | number | null,
    changes?: Change[],
    provider?: ProviderFailure,
  ) {
    const all = changes ?? [{ resource, property, expected, observed }];
    super(
      all
        .map(
          (change) =>
            `${change.resource}: ${change.property} expected ${change.expected}, observed ${change.observed}`,
        )
        .join("; ") +
        (provider
          ? "; Cloudflare " +
            [
              ...provider.errors.map((row) => `error ${row.code ?? "unknown"}: ${row.message}`),
              ...provider.messages.map((row) => `message ${row.code ?? "unknown"}: ${row.message}`),
              ...(provider.body === "json" ? [] : [`body ${provider.body}`]),
              ...(provider.omitted ? [`${provider.omitted} additional entries omitted`] : []),
            ].join("; ")
          : ""),
    );
    this.resource = resource;
    this.property = property;
    this.expected = expected;
    this.observed = observed;
    this.changes = all;
    this.provider = provider;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const safeValue = (value: unknown, path: string): string | number | null => {
  if (value === undefined) return "absent";
  if (value === null) return null;
  if (
    /^(?:logpush|observability\.(?:enabled|redactQueryString|(?:logs|traces|issues)\.(?:enabled|invocationLogs|persist)))$/.test(
      path,
    ) &&
    typeof value === "boolean"
  )
    return String(value);
  if (
    /^limits\.(?:cpu_ms|cpuMs|subrequests)$/.test(path) &&
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  )
    return value;
  return `sha256:${digest(value)}`;
};
export function differences(resource: string, before: unknown, after: unknown): Change[] {
  const changes: Change[] = [];
  const walk = (old: unknown, next: unknown, keys: string[], display: string[]) => {
    if (Object.is(old, next)) return;
    if (keys.length < 12 && (record(old) || old == null) && (record(next) || next == null)) {
      const a = record(old) ? old : {};
      const b = record(next) ? next : {};
      const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      if (names.length) {
        for (const key of names) {
          const path = [...keys, key];
          walk(a[key], b[key], path, [...display, publicPropPath(path).split(".").at(-1)!]);
        }
        return;
      }
    }
    if (keys.length < 12 && Array.isArray(old) && Array.isArray(next)) {
      for (let i = 0; i < Math.max(old.length, next.length); i++)
        walk(old[i], next[i], [...keys, String(i)], [...display, String(i)]);
      return;
    }
    if (digest(old) === digest(next) && (old === undefined) === (next === undefined)) return;
    // Cloudflare's annotation names contain slashes. Keep lookup keys separate from display paths.
    const property =
      keys.length === 2 &&
      keys[0] === "annotations" &&
      /^workers\/(?:message|tag|triggered_by)$/.test(keys[1]!)
        ? keys.join(".")
        : display.join(".") || "$";
    changes.push({
      resource,
      property,
      expected: safeValue(old, property),
      observed: safeValue(next, property),
    });
  };
  walk(before, after, [], []);
  return changes;
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
