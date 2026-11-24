import { runtimeReadStep, type RuntimeReadTrace } from "../runtime-read-trace.ts";
import { containerAnswer } from "../controller-unsent.ts";
import { resumeLayerPort } from "../stream-resume.ts";
import { routeSafeAnswer } from "../route-refusal.ts";
import { refuseRuntime, type RuntimeRouteDiagnostic } from "../runtime-route-diagnostic.ts";
import { PoolRuntimeUnhealthy, poolLifecycle } from "../lifecycle.ts";
import { SlotRefused } from "./contract.ts";
import { runtimePolicyAssertion } from "./policy-assertion.ts";
import type { RuntimeConfiguration, RuntimeEnvironment } from "./configuration.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { installNativePolicy } from "../native-policy-install.ts";
import { reportPoolFailure } from "../json.ts";
import { readRuntimeHealth } from "../runtime-health.ts";
import { policyUsePrefix, type NativeMembershipPolicy } from "../membership-contract.ts";
import { signEnvelope } from "../token.ts";
import { ReadinessReadFailure } from "../runtime-health.ts";

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
    // Before any send: a stopped container's refusal proves the call reached no container.
    if (!this.ctx.container?.running)
      refuseRuntime("endpoint_health", new SlotRefused("unhealthy"));
    await this.ctx.container
      .setInactivityTimeout(poolLifecycle.idleTimeoutMs)
      .catch((error: unknown) => refuseRuntime("endpoint_health", error));
  }
  async health(configuration: RuntimeConfiguration, signal: AbortSignal, trace?: RuntimeReadTrace) {
    if (!this.ctx.container?.running) throw new SlotRefused("unhealthy");
    const status = await readRuntimeHealth(
      this.port(8318),
      configuration.managementKey,
      signal,
      undefined,
      trace,
    ).catch((error: unknown) => {
      if (!(error instanceof ReadinessReadFailure)) refuseRuntime("endpoint_health", error);
      // A readiness read that failed in transport or returned an unparsable body is degraded
      // readiness: it refuses like a 503 so the caller can wait. Its refusal looks like any other
      // 503, so this line is what tells a broken readiness port apart.
      console.error("POOL_RUNTIME_READINESS_READ_FAILED " + JSON.stringify({ kind: error.kind }));
      refuseRuntime("endpoint_health", new PoolRuntimeUnhealthy());
    });
    if (!status.policyLeaseUntil || status.policyLeaseUntil <= performance.now())
      throw new SlotRefused("unhealthy");
    return status;
  }
  async install(configuration: RuntimeConfiguration, policy: NativeMembershipPolicy) {
    if (!this.ctx.container) throw new SlotRefused("unhealthy");
    try {
      return await installNativePolicy(
        this.ctx.container,
        { signingKey: configuration.signingKey, managementKey: configuration.managementKey },
        policy,
      );
    } catch (error) {
      // The refusal reaches the controller as a plain 409, which drops the plugin's closed reason
      // (for example a projection outside its lease window). Record it here, where it is known.
      reportPoolFailure(error);
      throw error;
    }
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
    port: 8317 | 8327 | 8318 | typeof resumeLayerPort,
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
      step = target === resumeLayerPort ? "resume_layer" : "port_dispatch";
      return await runtimeReadStep(
        trace,
        "port_headers",
        async () => {
          const answer = containerAnswer(
            await destination.fetch(new Request(request, { headers })),
          );
          return routeSafeAnswer(request, port, answer);
        },
        // Only the readiness and management ports are traced reads; model calls never are.
        target === 8318 || target === 8327 || target === 8329 ? target : undefined,
      );
    } catch (error) {
      // A stopped container is the runtime's failure on either port, never the front layer's.
      if ((port === 8317 || port === resumeLayerPort) && this.ctx.container?.running === false)
        refuseRuntime(
          step === "resume_layer" ? "port_dispatch" : step,
          new SlotRefused("unhealthy"),
        );
      refuseRuntime(step, error);
    }
  }
}
