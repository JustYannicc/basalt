import { providerChanges, safeProviderFailure } from "./operation-failure.ts";
import { BarrierRefusal } from "./manifest.ts";
import type { PropChange } from "./prop-diff.ts";

export type BucketOperation =
  | "prepare-d1"
  | "read-d1"
  | "create-d1"
  | "preflight-d1"
  | "prepare-bucket"
  | "read-bucket"
  | "create-bucket"
  | "configure-bucket"
  | "record-intent"
  | "commit-native-state";

/** Provider text and URLs are private. Retain only closed tags, bounded numbers and sanitized request shapes. */
export function bucketFailure(
  error: unknown,
  fqn: string,
  operation: BucketOperation,
  reason = "declared-bucket-provider-failed",
  type = "Cloudflare.R2.Bucket",
) {
  if (error instanceof BarrierRefusal) return error;
  const changed: PropChange[] = [
    { path: "$operation", old: null, new: operation },
    ...providerChanges(safeProviderFailure(error)),
  ];
  return new BarrierRefusal(reason, fqn, { fqn, type, changed });
}

export async function bucketRead<A>(fqn: string, read: () => Promise<A>): Promise<A> {
  try {
    return await read();
  } catch (error) {
    throw bucketFailure(error, fqn, "read-bucket");
  }
}
