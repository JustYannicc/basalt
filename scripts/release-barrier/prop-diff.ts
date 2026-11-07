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

const credentialShape = (value: string) =>
  /(?:AKIA|ASIA)[A-Z0-9]{16}|(?:^|[\s_/:])(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat)[_-]/i.test(
    value,
  ) || /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(value);
const tokenLike = (value: string) =>
  credentialShape(value) || /^[A-Za-z0-9_+/-]{24,}={0,2}$/.test(value);
const privateFields = new Set([
  "env",
  "secrets",
  "bindings",
  "credentials",
  "name",
  "type",
  "text",
  "value",
  "id",
  "accountId",
  "clientId",
  "clientSecret",
  "accessToken",
  "refreshToken",
  "key",
]);

function pathKey(key: string, parents: string[]) {
  const privateMap = parents.some(
    (parent) => privatePath.test(parent) && !/^env(?:ironment_variables)?$/i.test(parent),
  );
  const environment = parents.some((parent) => /^env(?:ironment_variables)?$/i.test(parent));
  if (
    !/^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/.test(key) ||
    (tokenLike(key) && !privateFields.has(key)) ||
    (privateMap && !privateFields.has(key)) ||
    (environment && !/^[A-Z_][A-Z0-9_]*$/.test(key) && !privateFields.has(key))
  )
    return "[changed]";
  return key;
}

function publicScalar(value: unknown, keys: string[]): Scalar | undefined {
  if (value == null) return null;
  const field = keys.at(-1) ?? "";
  const hash = /hash|digest/i.test(keys.join("."));
  if (!publicField.test(field) && !hash) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  if (
    /[\s?=#\\]|^[/~]|:\/\/|bearer|private.?key|password|secret|token/i.test(value) ||
    credentialShape(value)
  )
    return undefined;
  // Only these formats can exempt a long opaque string from token redaction.
  const digest = hash && /^(?:sha256:)?[a-f0-9]{16,128}$/i.test(value);
  const image =
    /^(?:image|imageRef)$/i.test(field) &&
    /^(?:(?:registry\.cloudflare\.com|docker\.io|ghcr\.io|quay\.io|public\.ecr\.aws)\/)?[a-z0-9_/-]+(?::[a-z0-9_.-]+|@sha256:[a-f0-9]{64})$/i.test(
      value,
    );
  const tag = value.slice(value.lastIndexOf(":") + 1);
  if (digest || (image && (!tokenLike(tag) || /^[a-f0-9]{16,128}$/i.test(tag))))
    return value.slice(0, 200);
  if (hash || tokenLike(value)) return undefined;
  if (/^version$/i.test(field))
    return /^v?[0-9]+(?:\.[0-9]+)*(?:-[a-z0-9.-]+)?$/i.test(value)
      ? value.slice(0, 200)
      : undefined;
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) return undefined;
  return value.slice(0, 200);
}

/** Public receipts retain only selected scalar values, never arbitrary serialized props. */
export function changedProps(olds: unknown, news: unknown): PropChange[] {
  const changes: PropChange[] = [];
  const walk = (old: unknown, next: unknown, keys: string[], rawKeys: string[], depth: number) => {
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
        const safeKey = pathKey(key, rawKeys);
        walk(before[key], after[key], [...keys, safeKey], [...rawKeys, key], depth + 1);
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
        walk(
          old[index],
          next[index],
          [...keys, String(index)],
          [...rawKeys, String(index)],
          depth + 1,
        );
      return;
    }
    const before = publicScalar(old, rawKeys);
    const after = publicScalar(next, rawKeys);
    changes.push(
      !privatePath.test(rawKeys.join(".")) && before !== undefined && after !== undefined
        ? { path, old: before, new: after }
        : { path, changed: true },
    );
  };
  walk(olds, news, [], [], 0);
  return changes;
}
