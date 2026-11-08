import { canonical } from "./manifest.ts";

export interface ActiveWorkerPlacement {
  id: string;
  placement: unknown;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const target = (value: unknown) => {
  if (!record(value) || !keys(value, ["id", "type", "region", "host", "hostname"]))
    throw new Error("unresolved-script-placement");
  const fields = ["region", "host", "hostname"].filter((key) => value[key] !== undefined);
  const key = fields[0];
  if (
    fields.length !== 1 ||
    !key ||
    typeof value[key] !== "string" ||
    !value[key] ||
    (value.id !== undefined && (!Number.isSafeInteger(value.id) || Number(value.id) < 0)) ||
    (value.type !== undefined && value.type !== key)
  )
    throw new Error("unresolved-script-placement");
  return { [key]: value[key] };
};

export const needsPlacementProof = (placement: unknown) =>
  record(placement) &&
  Array.isArray(placement.target) &&
  placement.target.some((value) => typeof value === "number");

/** A numeric target is meaningful only through the immutable versions actually serving traffic. */
export function normalizePlacement(
  placement: unknown,
  versions: readonly ActiveWorkerPlacement[] = [],
  baseline: readonly { versionId: string }[] = [],
): unknown {
  if (placement == null) return null;
  if (!record(placement)) throw new Error("unresolved-script-placement");
  if (
    !keys(placement, ["mode", "region", "host", "hostname", "target", "status", "lastAnalyzedAt"])
  )
    throw new Error("unresolved-script-placement");
  const direct = ["region", "host", "hostname"].some((key) => placement[key] !== undefined);
  if (direct) {
    if (
      placement.target !== undefined ||
      (placement.mode !== undefined && placement.mode !== "targeted")
    )
      throw new Error("unresolved-script-placement");
    return {
      mode: "targeted",
      target: [
        target(
          Object.fromEntries(
            Object.entries(placement).filter(([key]) =>
              ["region", "host", "hostname"].includes(key),
            ),
          ),
        ),
      ],
    };
  }
  if (placement.mode !== "targeted") {
    if (!["smart", "off"].includes(String(placement.mode)) || placement.target !== undefined)
      throw new Error("unresolved-script-placement");
    return { mode: placement.mode };
  }
  if (!Array.isArray(placement.target) || !placement.target.length)
    throw new Error("unresolved-script-placement");
  const numeric = placement.target.some((value) => typeof value === "number");
  if (!numeric) return { mode: "targeted", target: placement.target.map(target) };
  if (
    !baseline.length ||
    versions.length !== baseline.length ||
    new Set(versions.map((version) => version.id)).size !== versions.length ||
    baseline.some((version) => !versions.some((proof) => proof.id === version.versionId))
  )
    throw new Error("unresolved-script-placement");
  const targets = placement.target.map((id) => {
    if (!Number.isSafeInteger(id) || Number(id) < 0) throw new Error("unresolved-script-placement");
    const resolved = versions.map((version) => {
      const observed = version.placement;
      if (
        !record(observed) ||
        !keys(observed, ["mode", "target", "status", "lastAnalyzedAt"]) ||
        observed.mode !== "targeted" ||
        !Array.isArray(observed.target)
      )
        throw new Error("unresolved-script-placement");
      const matches = observed.target.filter((item) => record(item) && item.id === id);
      if (matches.length !== 1) throw new Error("unresolved-script-placement");
      return target(matches[0]);
    });
    if (resolved.some((value) => canonical(value) !== canonical(resolved[0])))
      throw new Error("conflicting-script-placement");
    return resolved[0];
  });
  return { mode: "targeted", target: targets };
}
