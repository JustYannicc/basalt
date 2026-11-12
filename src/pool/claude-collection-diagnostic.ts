import type { ClaudeQuotaShape } from "../../apps/pool/collection-diagnostic-contract.ts";
import { object } from "./json.ts";

const name = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(value) ? value : undefined;
const instant = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};
const number = (value: unknown, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : undefined;

export function claudeCollectionDiagnostic(value: unknown): ClaudeQuotaShape | undefined {
  if (
    !object(value) ||
    typeof value.limits_present !== "boolean" ||
    typeof value.grants_present !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    !Array.isArray(value.limits) ||
    value.limits.length > 32 ||
    !Array.isArray(value.grants) ||
    value.grants.length > 32
  )
    return undefined;
  const limits: ClaudeQuotaShape["limits"][number][] = [];
  const grants: ClaudeQuotaShape["grants"][number][] = [];
  for (const row of value.limits) {
    if (!object(row) || name(row.kind) === undefined) return undefined;
    limits.push({
      kind: name(row.kind)!,
      ...(name(row.model) === undefined ? {} : { model: name(row.model) }),
      ...(number(row.percent, 100) === undefined ? {} : { percent: number(row.percent, 100) }),
      ...(instant(row.resets_at) === undefined ? {} : { resetsAt: instant(row.resets_at) }),
    });
  }
  for (const row of value.grants) {
    if (
      !object(row) ||
      typeof row.gives_back_weekly !== "boolean" ||
      typeof row.paused !== "boolean" ||
      !Array.isArray(row.clears) ||
      row.clears.length > 16 ||
      row.clears.some((id) => name(id) === undefined)
    )
      return undefined;
    const remaining = number(row.remaining, 1_000_000);
    grants.push({
      ...(name(row.type) === undefined ? {} : { type: name(row.type) }),
      ...(remaining === undefined || !Number.isInteger(remaining) ? {} : { remaining }),
      clears: row.clears.filter((id): id is string => typeof id === "string"),
      givesBackWeekly: row.gives_back_weekly,
      paused: row.paused,
      ...(instant(row.starts_at) === undefined ? {} : { startsAt: instant(row.starts_at) }),
      ...(instant(row.ends_at) === undefined ? {} : { endsAt: instant(row.ends_at) }),
    });
  }
  return {
    limitsPresent: value.limits_present,
    grantsPresent: value.grants_present,
    truncated: value.truncated,
    limits,
    grants,
  };
}

export function sourceClaudeDiagnostic(value: ClaudeQuotaShape) {
  return {
    limits_present: value.limitsPresent,
    grants_present: value.grantsPresent,
    truncated: value.truncated,
    limits: value.limits.map((row) => ({
      kind: row.kind,
      ...(row.model === undefined ? {} : { model: row.model }),
      ...(row.percent === undefined ? {} : { percent: row.percent }),
      ...(row.resetsAt === undefined ? {} : { resets_at: row.resetsAt }),
    })),
    grants: value.grants.map((row) => ({
      ...(row.type === undefined ? {} : { type: row.type }),
      ...(row.remaining === undefined ? {} : { remaining: row.remaining }),
      clears: row.clears,
      gives_back_weekly: row.givesBackWeekly,
      paused: row.paused,
      ...(row.startsAt === undefined ? {} : { starts_at: row.startsAt }),
      ...(row.endsAt === undefined ? {} : { ends_at: row.endsAt }),
    })),
  };
}
