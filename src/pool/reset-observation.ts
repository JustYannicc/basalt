import type {
  BankedResetGroup,
  ResetMetadata,
  ResetScope,
} from "../../apps/pool/reset-observation-contract.ts";
import { object, rows, text } from "./json.ts";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
const instant = (value: unknown): string | null => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
};
const kinds = ["session", "weekly", "full", "model", "unknown"] as const;

function metadata(value: unknown): ResetMetadata {
  if (!object(value)) return { kind: "unknown" };
  const kind = kinds.find((kind) => kind === value.kind) ?? "unknown";
  const clears = Array.isArray(value.clears)
    ? value.clears
        .filter((id): id is string => typeof id === "string" && /^[a-z0-9_-]{1,64}$/.test(id))
        .slice(0, 16)
    : undefined;
  return {
    kind,
    ...(clears === undefined ? {} : { clears }),
    ...(typeof value.gives_back_weekly === "boolean"
      ? { givesBackWeekly: value.gives_back_weekly }
      : {}),
  };
}

function scope(value: unknown): ResetScope {
  if (!object(value)) return { kind: "unknown" };
  if (value.scope === "account") return { kind: "account" };
  const id = text(value.scope_id)?.trim();
  return value.scope === "model" && id && /^[a-z0-9_-]{1,64}$/.test(id)
    ? { kind: "model", id }
    : { kind: "unknown" };
}

function label(reset: ResetMetadata, scope: ResetScope) {
  if (scope.kind === "model" && scope.id)
    return `${scope.id.replace(/(^|[-_])([a-z])/g, (_, separator: string, letter: string) => `${separator ? " " : ""}${letter.toUpperCase()}`)} resets`;
  if (scope.kind !== "account") return "Resets with unknown scope";
  if (reset.kind === "weekly") return "Weekly resets";
  if (reset.kind === "session") return "5-hour resets";
  if (reset.kind === "full") return "Full resets";
  return "Banked resets";
}

/** Shared by native account reports and pool reads. Old aggregate-only snapshots stay unclassified. */
export function resetObservation(value: unknown, now: number) {
  if (!object(value) || !count(value.available_count)) return null;
  const groups = new Map<string, BankedResetGroup>();
  let listed = 0;
  for (const credit of rows(value.credits)) {
    if (credit.status !== "available") continue;
    const available =
      credit.remaining === undefined ? 1 : count(credit.remaining) ? credit.remaining : 0;
    listed += available;
    const expiresAt = instant(credit.expires_at);
    if (available === 0 || (expiresAt !== null && Date.parse(expiresAt) <= now)) continue;
    const reset = metadata(credit),
      modelScope = scope(credit);
    const key = JSON.stringify([reset, modelScope, expiresAt]);
    const previous = groups.get(key);
    groups.set(key, {
      label: label(reset, modelScope),
      available: (previous?.available ?? 0) + available,
      expiresAt,
      scope: modelScope,
      reset,
    });
  }
  // Incomplete old snapshots carry no evidence for a weekly or model classification.
  const unknown = Math.max(0, value.available_count - listed);
  if (unknown > 0 || (groups.size === 0 && value.available_count === 0)) {
    groups.set("unknown", {
      label: "Resets with unknown scope",
      available: unknown,
      expiresAt: null,
      scope: { kind: "unknown" },
      reset: { kind: "unknown" },
    });
  }
  if (listed > value.available_count) {
    return {
      available: value.available_count,
      nextExpiresAt: null,
      groups: [
        {
          label: "Resets with unknown scope",
          available: value.available_count,
          expiresAt: null,
          scope: { kind: "unknown" as const },
          reset: { kind: "unknown" as const },
        },
      ],
    };
  }
  const result = [...groups.values()].sort(
    (a, b) =>
      (a.expiresAt === null ? Infinity : Date.parse(a.expiresAt)) -
        (b.expiresAt === null ? Infinity : Date.parse(b.expiresAt)) ||
      a.label.localeCompare(b.label),
  );
  return {
    available: result.reduce((sum, group) => sum + group.available, 0),
    nextExpiresAt:
      result.find((group) => group.available > 0 && group.expiresAt !== null)?.expiresAt ?? null,
    groups: result,
  };
}
