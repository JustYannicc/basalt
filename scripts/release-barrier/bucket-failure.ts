import { BarrierRefusal } from "./manifest.ts";
import type { PropChange } from "./prop-diff.ts";

type Operation = "read-bucket" | "create-bucket" | "configure-bucket";
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
const boundedInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** Provider text and URLs are private. Only bounded numeric diagnostics cross into the refusal receipt. */
export function bucketFailure(
  error: unknown,
  fqn: string,
  operation: Operation,
  reason = "declared-bucket-provider-failed",
) {
  if (error instanceof BarrierRefusal) return error;
  const changed: PropChange[] = [{ path: "$operation", old: null, new: operation }];
  const status = field(error, "status");
  if (boundedInteger(status, 100, 599))
    changed.push({ path: "$provider.status", old: null, new: status });
  const errors = field(error, "errors");
  const codes = [
    ...new Set(
      [
        field(error, "code"),
        ...(Array.isArray(errors) ? errors.slice(0, 8).map((item) => field(item, "code")) : []),
      ].filter((code) => boundedInteger(code, 0, 2_147_483_647)),
    ),
  ].sort((a, b) => a - b);
  for (const [index, code] of codes.entries())
    changed.push({ path: `$provider.codes.${index}`, old: null, new: code });
  const tag = field(error, "_tag");
  if (tag === "TimeoutError")
    changed.push({ path: "$provider.timeout", old: null, new: "15 seconds" });
  return new BarrierRefusal(reason, fqn, { fqn, type: "Cloudflare.R2.Bucket", changed });
}

export async function bucketRead<A>(fqn: string, read: () => Promise<A>): Promise<A> {
  try {
    return await read();
  } catch (error) {
    throw bucketFailure(error, fqn, "read-bucket");
  }
}
