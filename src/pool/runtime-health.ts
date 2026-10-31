import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";

export const policyHealthLeaseMs = 1_500;
export const policyHealthRefreshMs = 500;
export const policyHealthProbeMs = 250;
export const policyHealthHeader = "X-Signalbox-Policy-Lease-Ms";

/** Start the remaining lease at request dispatch, so transport delay cannot extend it. */
export async function readRuntimeHealth(
  readiness: { fetch(input: string, init: RequestInit): Promise<Response> },
  managementKey: string,
  signal: AbortSignal,
  now = () => performance.now(),
): Promise<PoolStatus> {
  const requestedAt = now();
  const response = await readiness.fetch("http://pool/ready", {
    signal, headers: { Authorization: `Bearer ${managementKey}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new PoolRuntimeUnhealthy();
  }
  const status: unknown = await response.json();
  if (typeof status !== "object" || status === null || !("boot_id" in status) || !("started_at" in status)
    || typeof status.boot_id !== "string" || typeof status.started_at !== "string")
    throw new PoolRuntimeUnhealthy();
  const remaining = response.headers.get(policyHealthHeader);
  const milliseconds = remaining !== null && /^[1-9]\d*$/.test(remaining) ? Number(remaining) : 0;
  return { boot_id: status.boot_id, started_at: status.started_at,
    ...(milliseconds > 0 && milliseconds <= policyHealthLeaseMs
      ? { policyLeaseUntil: requestedAt + milliseconds } : {}),
  };
}
