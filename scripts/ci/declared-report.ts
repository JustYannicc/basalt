import type { DeclaredResult } from "./run-declared.ts";
import { runKey } from "./shards.ts";

// GitHub keeps ten annotations of each level per step: nine retried files and one line for the rest.
export const retryAnnotations = 9;

export const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;

export const conclusion = (result: DeclaredResult) => {
  if (result.attempts.length < 2) return result.outcome;
  if (result.outcome === "passed") return "passed on retry";
  return result.outcome === "failed"
    ? "failed twice"
    : "failed, then " + result.outcome.replace("-", " ");
};

export const row = (result: DeclaredResult) =>
  `| ${result.file} | ${result.group} | ${conclusion(result)} | ${duration(result.seconds)} |\n`;

export function annotation(result: DeclaredResult) {
  const key = runKey(result);
  const retried = result.attempts.length > 1;
  if (retried && result.outcome === "passed")
    return `::warning title=e2e retry::${key} passed on retry`;
  if (result.outcome === "passed") return undefined;
  return (
    (retried ? "::error title=e2e retry::" : `::error title=Declared E2E ${result.outcome}::`) +
    `${key} ${conclusion(result)}` +
    (result.outcome === "timed-out" ? " at its per-file deadline" : "") +
    (result.code === null ? "" : ` (exit ${result.code})`) +
    ` after ${duration(result.seconds)}`
  );
}

/** Stands in for the retried files past the annotation limit; the summary still lists each. */
export const overflowAnnotation = (unannotated: readonly DeclaredResult[]) =>
  `::${unannotated.some((result) => result.outcome !== "passed") ? "error" : "warning"} ` +
  `title=e2e retry::…and ${unannotated.length} more retried files (see the job summary)`;
