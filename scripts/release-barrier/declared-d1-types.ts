import type { CreatingResourceState } from "alchemy/State/ResourceState";
import type { Database } from "alchemy/Cloudflare/D1";
import { declaredMismatch } from "./declared-refusal.ts";
import { bucketFailure, type BucketOperation } from "./bucket-failure.ts";

export interface D1Target {
  accountId: string;
  databaseName: string;
  jurisdiction: "eu";
}
export interface D1Provider {
  accountId(): Promise<string>;
  preflight(accountId: string): Promise<void>;
  exists(target: D1Target): Promise<boolean>;
  create(target: D1Target): Promise<string>;
  read(
    target: D1Target,
    databaseId: string,
    fqn: string,
  ): Promise<Database["Attributes"] | undefined>;
}
export interface PreparedD1 {
  fqn: string;
  declaration: string;
  entry: string;
  target: D1Target;
  databaseId?: string;
  native: CreatingResourceState;
  initialLifecycle: "absent" | "creating";
  resume: boolean;
}
export interface D1Progress {
  database: PreparedD1;
  lifecycle: "planned" | "creating" | "created";
  outcome: "not-started" | "pending" | "acknowledged" | "confirmed" | "unknown";
}
export const d1Mismatch = (reason: string, fqn: string, expected: unknown, observed: unknown) =>
  declaredMismatch(reason, fqn, expected, observed, "Cloudflare.D1Database");
export const d1Failure = (
  error: unknown,
  fqn: string,
  operation: BucketOperation,
  reason = "declared-d1-provider-failed",
) => bucketFailure(error, fqn, operation, reason, "Cloudflare.D1Database");
export async function d1Read<A>(fqn: string, read: () => Promise<A>) {
  try {
    return await read();
  } catch (error) {
    throw d1Failure(error, fqn, "read-d1");
  }
}
