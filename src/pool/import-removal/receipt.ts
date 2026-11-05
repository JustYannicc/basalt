import { Schema } from "effect";
import {
  canonical,
  sha256,
} from "../../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/crypto.ts";
import type { RemovalDiagnostic } from "./failure.ts";

export const Receipt = Schema.Struct({
  status: Schema.Literals(["started", "incomplete", "complete"]),
  planSha256: Schema.String,
  retainSha256: Schema.String,
  removed: Schema.Array(Schema.String),
  memberships: Schema.Array(Schema.String),
});
export interface RemovalReceipt {
  status: "started" | "incomplete" | "complete";
  planSha256: string;
  retainSha256: string;
  removed: string[];
  memberships: string[];
  originalPlanSha256?: string;
  priorRecoveryPlanSha256?: string;
  pending?: { kind: "credential" | "membership"; id: string; beforeSha256: string };
  failure?: RemovalDiagnostic;
}
export const receiptKey = (planSha256: string) => `import-removal:${planSha256}`;
export const recoveryKey = (originalPlanSha256: string) =>
  `import-removal-recovery:${originalPlanSha256}`;
export const receiptHash = (receipt: unknown) => sha256(canonical(receipt));

export async function unresolvedRemoval(storage: {
  list(options: { prefix: string; limit: number }): Promise<Map<string, unknown>>;
  get<T>(key: string): Promise<T | undefined>;
}) {
  const receipts = await storage.list({ prefix: "import-removal:", limit: 1001 });
  if (receipts.size > 1000) return true;
  for (const value of receipts.values()) {
    const parsed = Schema.decodeUnknownExit(Receipt)(value);
    if (parsed._tag === "Failure") return true;
    const receipt = parsed.value;
    if (receipt.status === "complete") continue;
    const root =
      value &&
      typeof value === "object" &&
      "originalPlanSha256" in value &&
      typeof value.originalPlanSha256 === "string"
        ? value.originalPlanSha256
        : receipt.planSha256;
    const head = await storage.get<string>(recoveryKey(root));
    const latest = head ? await storage.get<RemovalReceipt>(receiptKey(head)) : undefined;
    if (!latest || latest.status !== "complete" || latest.originalPlanSha256 !== root) return true;
  }
  return false;
}
