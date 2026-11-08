import { BarrierRefusal } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";

const enums = new Set([
  "jurisdiction",
  "readReplication",
  "status",
  "outcome",
  "resource",
  "nativeRow",
  "outputType",
  "accountScope",
  "creationEvidence",
  "readinessEvidence",
  "providerMode",
  "previousSettings",
  "previousProps",
  "usageModel",
]);
const values = new Set([
  "eu",
  "us",
  "default",
  "fedramp",
  "auto",
  "disabled",
  "creating",
  "created",
  "updated",
  "pending",
  "acknowledged",
  "present",
  "exists",
  "configured",
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
  "live",
  "local",
  "standard",
  "bundled",
  "unbound",
]);
const numbers = new Set([
  "providerVersion",
  "savedProviderVersion",
  "nativeProviderVersion",
  "domainCount",
  "corsCount",
  "lifecycleRuleCount",
]);
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
function publicValue(value: unknown, path: string): string | number | null | undefined {
  if (
    !enums.has(path) &&
    !numbers.has(path) &&
    !["declaration", "entry", "publicAccess", "publicDomain"].includes(path)
  )
    return undefined;
  if (value == null) return null;
  if (enums.has(path) && typeof value === "string" && values.has(value)) return value;
  if (numbers.has(path) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return value;
  if (
    ["declaration", "entry"].includes(path) &&
    typeof value === "string" &&
    /^[a-f0-9]{64}$/u.test(value)
  )
    return value;
  if (["publicAccess", "publicDomain"].includes(path) && typeof value === "boolean")
    return String(value);
  return undefined;
}

/** Closed lifecycle values and digests are public; arbitrary native properties keep the shared redaction policy. */
export const declaredMismatch = (
  reason: string,
  fqn: string,
  expected: unknown,
  observed: unknown,
  type = "Cloudflare.R2.Bucket",
) =>
  new BarrierRefusal(reason, fqn, {
    fqn,
    type,
    changed: changedProps(expected, observed).map((change) => {
      if ("old" in change || change.path.includes(".")) return change;
      const old = publicValue(field(expected, change.path), change.path);
      const next = publicValue(field(observed, change.path), change.path);
      return old !== undefined && next !== undefined
        ? { path: change.path, old, new: next }
        : change;
    }),
  });
