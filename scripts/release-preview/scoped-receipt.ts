import {
  scopedPreviewPassed,
  type ScopedPreviewResult,
} from "../pool-acceptance/preview-scoped-result.ts";
import { requireSuccessfulCatalogAcceptance } from "./catalog-acceptance-receipt.ts";
import type { CatalogAcceptanceResult } from "./catalog-acceptance.ts";

export interface PreviewPoolEvidence {
  model: "claude-opus-5-5";
  requests: number;
  planQuotaChecked: true;
  extraUsageDisabled: true;
  revoked: true;
  unauthorized: true;
}
export interface ScopedPreviewReceipt {
  version: 2;
  pullRequest: number;
  head: string;
  base: string;
  smoke: true;
  teardown: true;
  coverage: ScopedPreviewResult;
  poolGrant: PreviewPoolEvidence;
  catalogAcceptance?: CatalogAcceptanceResult;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join("\n") === keys.sort().join("\n");
}
export function successfulPoolEvidence(value: unknown): value is PreviewPoolEvidence {
  return (
    object(value) &&
    exact(value, [
      "model",
      "requests",
      "planQuotaChecked",
      "extraUsageDisabled",
      "revoked",
      "unauthorized",
    ]) &&
    value.model === "claude-opus-5-5" &&
    typeof value.requests === "number" &&
    Number.isSafeInteger(value.requests) &&
    value.requests > 0 &&
    value.planQuotaChecked === true &&
    value.extraUsageDisabled === true &&
    value.revoked === true &&
    value.unauthorized === true
  );
}

/** V2 names its narrower coverage; old two-live-client receipts cannot satisfy this contract. */
export function validateScopedPreviewReceipt(
  value: unknown,
  expected: { pullRequest: number; head: string; base: string },
): string[] {
  if (!object(value)) return ["preview receipt is not an object"];
  const keys = [
    "version",
    "pullRequest",
    "head",
    "base",
    "smoke",
    "teardown",
    "coverage",
    "poolGrant",
  ];
  if ("catalogAcceptance" in value) keys.push("catalogAcceptance");
  const problems: string[] = [];
  if (!exact(value, keys)) problems.push("preview receipt has unexpected fields");
  if (value.version !== 2) problems.push("scoped preview receipt requires version 2");
  if (value.pullRequest !== expected.pullRequest)
    problems.push("preview receipt pull request does not match");
  if (value.head !== expected.head) problems.push("preview receipt head does not match");
  if (value.base !== expected.base)
    problems.push("preview receipt base does not match current main");
  if (value.smoke !== true || !scopedPreviewPassed(value.coverage))
    problems.push("preview live and fixture coverage is missing or incomplete");
  if (!successfulPoolEvidence(value.poolGrant))
    problems.push("preview plan-only model grant and verified revocation proof is missing");
  if (value.teardown !== true) problems.push("preview teardown proof is missing");
  if ("catalogAcceptance" in value) {
    try {
      requireSuccessfulCatalogAcceptance(value.catalogAcceptance, expected.head);
    } catch {
      problems.push("preview catalog compiler acceptance is missing or incomplete");
    }
  }
  return problems;
}
