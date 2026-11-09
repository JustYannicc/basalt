import { HomeClient, PoolHome } from "./control.ts";
import { BackendFailure } from "./json.ts";
import { policyUsePrefix, type NativeMembershipPolicy } from "./membership-contract.ts";
import { readRuntimeHealth } from "./runtime-health.ts";
import { signEnvelope } from "./token.ts";

interface Runtime {
  running: boolean;
  getTcpPort(port: number): {
    fetch(input: string | Request, init?: RequestInit): Promise<Response>;
  };
}

/** Direct ports avoid managementReady, policy repair, quota collection and view snapshots. */
export function availabilityRuntime(
  runtime: Runtime | undefined,
  managementKey: string,
  signingKey: string,
) {
  const port = (number: number) => {
    if (!runtime?.running) throw new Error("Pool stopped");
    return runtime.getTcpPort(number);
  };
  return {
    async runtime(signal: AbortSignal) {
      const status = await readRuntimeHealth(port(8318), managementKey, signal);
      if (!status.policyLeaseUntil || status.policyLeaseUntil <= performance.now())
        throw new Error("Policy health unavailable");
    },
    async view(pool: string, signal: AbortSignal) {
      const home = new HomeClient(async (path, init) => {
        if (init?.method && init.method !== "GET") throw new Error("Probe refuses writes");
        const headers = new Headers(init?.headers);
        headers.set("X-Management-Key", managementKey);
        return port(8327).fetch(
          new Request(`http://pool${path}`, {
            ...init,
            headers,
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
          }),
        );
      });
      await new PoolHome(home, pool).readView(() => new Date());
    },
    async native(policy: NativeMembershipPolicy, signal: AbortSignal) {
      const assertion = await signEnvelope(signingKey, policyUsePrefix, {
        pool: policy.pool,
        revision: policy.revision,
        expiresAt: Date.now() + 30_000,
      });
      const response = await port(8318).fetch("http://pool/native-policy/check", {
        method: "POST",
        signal,
        headers: { Authorization: `Bearer ${managementKey}`, "content-type": "application/json" },
        body: JSON.stringify({ assertion }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new BackendFailure(response.status);
      }
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true)
        throw new Error("Invalid native guard response");
    },
  };
}
