import { Schema, SchemaIssue } from "effect";
import { publicPropPath } from "./prop-diff.ts";
import { BarrierRefusal } from "./manifest.ts";
import type { PropChange } from "./prop-diff.ts";
import { ReleaseOperationFailure, safeProviderFailure } from "./operation-failure.ts";

/** Callers supply closed scalar diagnostics or digests. Provider messages and binding values never enter a refusal. */
export const classRefusal = (reason: string, fqn: string | undefined, changed: PropChange[]) =>
  new BarrierRefusal(reason, fqn, { fqn: fqn ?? "(Worker)", type: "Cloudflare.Worker", changed });

export const classConstraint = (
  reason: string,
  fqn: string | undefined,
  path: string,
  expected: string | number | null,
  observed: string | number | null,
) => classRefusal(reason, fqn, [{ path, old: expected, new: observed }]);

export function classCheckFailure(error: unknown, fqn: string) {
  if (error instanceof BarrierRefusal && error.delta)
    return new BarrierRefusal(
      error.reason,
      error.worker ?? fqn,
      { ...error.delta, fqn: error.worker ?? fqn },
      error.refusals,
    );
  const provider =
    error instanceof ReleaseOperationFailure ? error.provider : safeProviderFailure(error);
  const changed: PropChange[] = [
    {
      path: "$operation",
      old: null,
      new: error instanceof ReleaseOperationFailure ? error.operation : "validate-class-expansion",
    },
  ];
  if (provider) {
    changed.push({ path: "$provider.type", old: null, new: provider.type });
    if (provider.reason !== undefined)
      changed.push({ path: "$provider.reason", old: null, new: provider.reason });
    if (provider.status !== undefined)
      changed.push({ path: "$provider.status", old: null, new: provider.status });
    for (const [index, code] of (provider.codes ?? []).entries())
      changed.push({ path: `$provider.codes.${index}`, old: null, new: code });
  }
  return classRefusal(
    error instanceof BarrierRefusal ? error.reason : "declared-class-provider-failed",
    fqn,
    changed,
  );
}

export function classSchemaRefusal(
  reason: string,
  fqn: string | undefined,
  prefix: string,
  error: unknown,
) {
  if (!Schema.isSchemaError(error)) throw error;
  const issues = SchemaIssue.makeFormatterStandardSchemaV1({
    leafHook: () => "unsupported",
    checkHook: () => "unsupported",
  })(error.issue).issues;
  return classRefusal(
    reason,
    fqn,
    issues.map((issue) => ({
      path: `${prefix}.${publicPropPath((issue.path ?? []).map((part) => String(typeof part === "object" ? part.key : part)))}`,
      old: "supported-value",
      new: "unsupported-value",
    })),
  );
}
