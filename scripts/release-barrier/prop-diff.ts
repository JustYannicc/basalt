import { deepEqual, isResolved } from "alchemy/Diff";
import { isRedacted } from "effect/Redacted";

type Scalar = string | number | null;
export type PropChange =
  | { path: string; old: Scalar; new: Scalar }
  | { path: string; changed: true };

export interface ResourceDelta {
  fqn: string;
  type: string;
  changed: PropChange[];
}

const privatePath = /env|secret|binding|credential|password|token|authorization|cookie|key/i;
const publicField =
  /^(?:hash|digest|image|imageRef|version|instanceType|instance_type|count|size|name|maxInstances|max_instances|vcpu|memory|memory_mib|disk|percentage|replicas|bytes)$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function publicScalar(value: unknown, keys: string[]): Scalar | undefined {
  if (value == null) return null;
  const field = keys.at(-1) ?? "";
  const hash = /hash|digest/i.test(keys.join("."));
  if (!publicField.test(field) && !hash) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  // Hashes and immutable image references are useful evidence; opaque tokens are not.
  const digest = /^(?:sha256:)?[a-f0-9]{16,128}$/i.test(value);
  const image =
    /^(?:[a-z0-9.-]+(?::[0-9]+)?\/)?[a-z0-9_./-]+(?::[a-z0-9_.-]+|@sha256:[a-f0-9]{64})$/i.test(
      value,
    );
  if (
    /bearer|private.?key|password|secret|token|(?:^|[\s_])(?:sk|pk|ghp|github_pat|AKIA)[_-]/i.test(
      value,
    ) ||
    /[\s?=#\\]|^[\/~]|:\/\/|^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(
      value,
    ) ||
    (value.includes("@") && !image) ||
    (/^[A-Za-z0-9_+/-]{24,}={0,2}$/.test(value) && !(hash && digest) && !image)
  )
    return undefined;
  return value.slice(0, 200);
}

/** Public receipts retain only selected scalar values, never arbitrary serialized props. */
export function changedProps(olds: unknown, news: unknown): PropChange[] {
  const changes: PropChange[] = [];
  const walk = (old: unknown, next: unknown, keys: string[], depth: number) => {
    if (changes.length >= 256 || Object.is(old, next)) return;
    const path = keys.join(".") || "$";
    if (depth >= 12) {
      changes.push({ path, changed: true });
      return;
    }
    if ((record(old) || old == null) && (record(next) || next == null)) {
      const before = record(old) ? old : {};
      const after = record(next) ? next : {};
      const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      if (!fields.length && !deepEqual(old, next)) changes.push({ path, changed: true });
      for (const key of fields) {
        // Property names can themselves be map keys containing credentials.
        const safeKey =
          /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/.test(key) &&
          !/^(?:sk_|pk_|ghp_|github_pat_|AKIA)/.test(key)
            ? key
            : "[changed]";
        walk(before[key], after[key], [...keys, safeKey], depth + 1);
      }
      return;
    }
    if (!isResolved(old) || !isResolved(next)) {
      changes.push({ path, changed: true });
      return;
    }
    if (deepEqual(old, next)) return;
    if (isRedacted(old) || isRedacted(next)) {
      changes.push({ path, changed: true });
      return;
    }
    if (Array.isArray(old) && Array.isArray(next)) {
      for (let index = 0; index < Math.max(old.length, next.length); index++)
        walk(old[index], next[index], [...keys, String(index)], depth + 1);
      return;
    }
    const before = publicScalar(old, keys);
    const after = publicScalar(next, keys);
    changes.push(
      !privatePath.test(keys.join(".")) && before !== undefined && after !== undefined
        ? { path, old: before, new: after }
        : { path, changed: true },
    );
  };
  walk(olds, news, [], 0);
  return changes;
}
