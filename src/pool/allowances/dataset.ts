import { vendorPlan } from "apps";
import {
  allowanceEntry,
  datasetUrl,
  date,
  https,
  object,
  sourceMaxAge,
  type PlanAllowance,
} from "./data.ts";

/** Exact maintained facts only: a bound or an arithmetic estimate is not an allowance. */
export function datasetAllowances(input: unknown, now: number): PlanAllowance[] {
  if (
    !object(input) ||
    !Array.isArray(input.options) ||
    input.options.length > 500 ||
    !["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"].includes(
      String(input.license),
    ) ||
    !Number.isFinite(date(input.as_of)) ||
    date(input.as_of) > now
  )
    throw new Error("Invalid allowance dataset");
  return input.options.flatMap((row): PlanAllowance[] => {
    if (
      !object(row) ||
      typeof row.label !== "string" ||
      typeof row.id !== "string" ||
      !["ok", "warn", "info"].includes(String(row.status_class)) ||
      !https(row.source) ||
      !object(row.multiple) ||
      row.multiple.floor !== "" ||
      !["baseline", "published", "reported"].includes(String(row.multiple.basis)) ||
      typeof row.multiple.x !== "number" ||
      !Number.isFinite(row.multiple.x) ||
      row.multiple.x <= 0 ||
      !Array.isArray(row.windows)
    )
      return [];
    const multiple = row.multiple;
    const checked = date(row.checked);
    if (!Number.isFinite(checked) || checked > now || now - checked >= sourceMaxAge) return [];
    const vendor =
      row.tool === "codex" ? "openai" : row.tool === "claude-code" ? "anthropic" : null;
    if (!vendor) return [];
    const label = row.label.replace(/^(?:ChatGPT|Claude)\s+/u, "");
    const display = vendorPlan(vendor, label);
    const plan = display.recognized
      ? display
      : vendorPlan(vendor, row.id.replace(/^(?:claude-|codex-chatgpt-)/u, "").replaceAll("-", " "));
    if (!plan.recognized) return [];
    // Business seat estimates and Team lower bounds do not prove a shared weekly ratio.
    if (/business|team|enterprise|edu/iu.test(plan.id)) return [];
    const reference = vendorPlan(
      vendor,
      String(row.multiple.base).replace(/^(?:ChatGPT|Claude)\s+/u, ""),
    );
    if (!reference.recognized) return [];
    const unit =
      reference.id === "plus" && vendor === "openai"
        ? { id: "chatgpt-plus-equivalent", label: "Plus-eq" }
        : reference.id === "pro" && vendor === "anthropic"
          ? { id: "claude-pro-equivalent", label: "Pro-eq" }
          : null;
    if (!unit) return [];
    return row.windows.flatMap((window): PlanAllowance[] => {
      if (!Array.isArray(window) || window.length !== 2) return [];
      const seconds = window[0] === "Weekly" ? 604_800 : window[0] === "5-hour" ? 18_000 : null;
      if (seconds === null) return [];
      const unlimited = window[1] === "None";
      if (!unlimited && !["Yes", "Yes, rolling", "May apply"].includes(String(window[1])))
        return [];
      return [
        allowanceEntry({
          vendor,
          plan: plan.id,
          windowSeconds: seconds,
          full: unlimited ? null : (multiple.x as number),
          unit,
          kind: "dataset",
          verification:
            multiple.basis === "baseline"
              ? "reference"
              : multiple.basis === "reported"
                ? "reported"
                : "verified",
          sources: [datasetUrl, String(row.source)],
          checkedAt: checked,
          fetchedAt: now,
          detail: `PlanYield CC BY 4.0; ${String(multiple.basis)}; ${String(multiple.source).slice(0, 256)}`,
          ...(unlimited ? { unlimited: true } : {}),
        }),
      ];
    });
  });
}
