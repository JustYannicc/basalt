import { safeProviderFailure } from "./operation-failure.ts";
import { BarrierRefusal } from "./manifest.ts";
import type { PropChange } from "./prop-diff.ts";

export type BucketOperation =
  | "prepare-bucket"
  | "read-bucket"
  | "create-bucket"
  | "configure-bucket"
  | "record-intent"
  | "commit-native-state";

/** Provider text and URLs are private. Retain only closed tags and bounded numeric diagnostics. */
export function bucketFailure(
  error: unknown,
  fqn: string,
  operation: BucketOperation,
  reason = "declared-bucket-provider-failed",
) {
  if (error instanceof BarrierRefusal) return error;
  const changed: PropChange[] = [{ path: "$operation", old: null, new: operation }];
  const provider = safeProviderFailure(error);
  changed.push({ path: "$provider.type", old: null, new: provider.type });
  if (provider.reason !== undefined)
    changed.push({ path: "$provider.reason", old: null, new: provider.reason });
  if (provider.status !== undefined)
    changed.push({ path: "$provider.status", old: null, new: provider.status });
  for (const [index, code] of (provider.codes ?? []).entries())
    changed.push({ path: `$provider.codes.${index}`, old: null, new: code });
  return new BarrierRefusal(reason, fqn, { fqn, type: "Cloudflare.R2.Bucket", changed });
}

export async function bucketRead<A>(fqn: string, read: () => Promise<A>): Promise<A> {
  try {
    return await read();
  } catch (error) {
    throw bucketFailure(error, fqn, "read-bucket");
  }
}
