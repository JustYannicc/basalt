import { runtimeReadStep, type RuntimeReadTrace } from "../runtime-read-trace.ts";
import { refuseRuntime, type RuntimeRouteDiagnostic } from "../runtime-route-diagnostic.ts";
import { poolLifecycle } from "../lifecycle.ts";
import { SlotRefused } from "./contract.ts";
import { runtimePolicyAssertion } from "./policy-assertion.ts";
import type { RuntimeConfiguration, RuntimeEnvironment } from "./configuration.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { installNativePolicy } from "../native-policy-install.ts";
import { readRuntimeHealth } from "../runtime-health.ts";
import { policyUsePrefix, type NativeMembershipPolicy } from "../membership-contract.ts";
import { signEnvelope } from "../token.ts";

/** Authenticated ports use the selected boot's preserved settings, not new controller bindings. */
export class RuntimeChannel {
  private ctx: RuntimeState;
  private env: RuntimeEnvironment;
  constructor(ctx: RuntimeState, env: RuntimeEnvironment) {
    this.ctx = ctx;
    this.env = env;
  }
  private port(number: number) {
    try {
      return this.ctx.container!.getTcpPort(number);
    } catch (error) {
      refuseRuntime("port_lookup", error);
    }
  }
  async keepAlive() {
    if (!this.ctx.container?.running) throw new SlotRefused("unhealthy");
    await this.ctx.container.setInactivityTimeout(poolLifecycle.idleTimeoutMs);
  }
  async health(configuration: RuntimeConfiguration, signal: AbortSignal, trace?: RuntimeReadTrace) {
    if (!this.ctx.container?.running) throw new SlotRefused("unhealthy");
    const status = await readRuntimeHealth(
      this.port(8318),
      configuration.managementKey,
      signal,
      undefined,
      trace,
    ).catch((error: unknown) => refuseRuntime("endpoint_health", error));
    if (!status.policyLeaseUntil || status.policyLeaseUntil <= performance.now())
      throw new SlotRefused("unhealthy");
    return status;
  }
  install(configuration: RuntimeConfiguration, policy: NativeMembershipPolicy) {
    if (!this.ctx.container) throw new SlotRefused("unhealthy");
    return installNativePolicy(
      this.ctx.container,
      { signingKey: configuration.signingKey, managementKey: configuration.managementKey },
      policy,
    );
  }
  async native(
    configuration: RuntimeConfiguration,
    policy: NativeMembershipPolicy,
    signal: AbortSignal,
  ) {
    const assertion = await signEnvelope(configuration.signingKey, policyUsePrefix, {
      pool: policy.pool,
      revision: policy.revision,
      expiresAt: Date.now() + 30_000,
    });
    const response = await this.ctx
      .container!.getTcpPort(8318)
      .fetch("http://pool/native-policy/check", {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${configuration.managementKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ assertion }),
      });
    if (!response.ok) {
      await response.body?.cancel();
      throw new SlotRefused("policy");
    }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true)
      throw new SlotRefused("policy");
  }
  async fetch(
    configuration: RuntimeConfiguration,
    request: Request,
    port: 8317 | 8327 | 8318,
    trace?: RuntimeReadTrace,
  ) {
    let step: RuntimeRouteDiagnostic["runtimeStep"] = "endpoint_request";
    try {
      const headers = new Headers(request.headers);
      await runtimeReadStep(trace, "request_prepare", () =>
        runtimePolicyAssertion(headers, {
          current: this.env.POOL_APP_SIGNING_KEY,
          previous: this.env.POOL_APP_SIGNING_KEY_PREVIOUS,
          runtime: configuration.signingKey,
        }),
      );
      if (port === 8327) headers.set("X-Management-Key", configuration.managementKey);
      if (port === 8318) headers.set("Authorization", `Bearer ${configuration.managementKey}`);
      const target = port === 8327 && configuration.homePeerOrdinal !== undefined ? 8329 : port;
      step = "port_lookup";
      const destination = this.port(target);
      step = "port_dispatch";
      return await runtimeReadStep(
        trace,
        "port_headers",
        () => destination.fetch(new Request(request, { headers })),
        target === 8317 ? undefined : target,
      );
    } catch (error) {
      refuseRuntime(step, error);
    }
  }
}
