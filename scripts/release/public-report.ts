import { safeJson } from "./safe-json.ts";

/**
 * What a stopped run says in public (the repository, its logs, step summaries and artifacts are
 * public) and what it keeps private. Public: the tagged reason in our own vocabulary and the error
 * class. Private: names, ids, paths, values and raw messages, which can carry hosts or account ids.
 */
export interface FailureReport {
  readonly publicText: string;
  readonly detail: string;
}

const PUBLIC_FIELDS = ["check", "rule", "field", "why", "fix"] as const;
const PRIVATE_FIELDS = ["resource", "script", "method", "path", "value"] as const;
const CHAIN = ["cause", "reason", "error", "defect", "failures", "reasons", "issue"] as const;

const errorClass = (error: unknown) => {
  if (error && typeof error === "object") {
    const tag = (error as { _tag?: unknown })._tag;
    if (typeof tag === "string") return tag;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
    return error.constructor?.name ?? "object";
  }
  return typeof error;
};

const fields = (record: Record<string, unknown>, keys: readonly string[]) =>
  keys
    .filter((key) => typeof record[key] === "string" || typeof record[key] === "number")
    .map((key) => `${key}=${String(record[key])}`);

export function failureReport(error: unknown): FailureReport {
  const publicLines: string[] = [];
  const detailLines: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 10) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      typeof record._tag === "string" &&
      /Refus|Refused|Failed|Unavailable|Possible/u.test(record._tag)
    ) {
      const violations = Array.isArray(record.violations)
        ? (record.violations as Array<Record<string, unknown>>)
        : [];
      const rules = violations
        .map((violation) => `${String(violation.rule)}@${String(violation.fqn)}`)
        .join(",");
      publicLines.push(
        [record._tag + ":", ...fields(record, PUBLIC_FIELDS), ...(rules ? [`rules=${rules}`] : [])]
          .join(" ")
          .trim(),
      );
      detailLines.push(
        [
          record._tag + ":",
          ...fields(record, [...PRIVATE_FIELDS, ...PUBLIC_FIELDS]),
          ...(record.detail ? [`detail=${safeJson(record.detail)}`] : []),
          ...(violations.length ? [`violations=${safeJson(violations)}`] : []),
        ].join(" "),
      );
    }
    for (const key of CHAIN)
      if (key in record) {
        const next = record[key];
        if (Array.isArray(next)) for (const item of next) visit(item, depth + 1);
        else visit(next, depth + 1);
      }
  };
  visit(error, 0);
  const message = error instanceof Error ? error.message : safeJson(error);
  return publicLines.length
    ? {
        publicText: `Release stopped:\n${publicLines.map((line) => `- ${line}`).join("\n")}`,
        detail: `Release stopped:\n${detailLines.map((line) => `- ${line}`).join("\n")}\n${message}`,
      }
    : {
        publicText: `Release stopped: ${errorClass(error)} (the message is in the sealed detail)`,
        detail: `Release stopped: ${errorClass(error)}: ${message}`,
      };
}
