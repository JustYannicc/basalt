import { runtimeInput } from "./input.ts";
import { remoteRuntimeDefect, runtimeErrorResponse } from "./request-error.ts";
import { EndpointTrace, failEndpointResponse } from "../runtime-fleet/endpoint-trace.ts";
import { homeResponse } from "../home-response.ts";
import { awaitProbe } from "../availability.ts";
import { retainRuntimeFailure, runtimeResponseDiagnostic } from "../runtime-route-diagnostic.ts";
import { Schema } from "effect";
import { StartupStopIntent, StartupStopRecord } from "./startup-abort-contract.ts";
import {
  SlotIdentity,
  SlotTarget,
  SlotRefused,
  RuntimeRetirementObservation,
  sameTarget,
  sameIdentity,
  type SlotHealth,
  type SlotDriver,
} from "./contract.ts";
import { RuntimeEndpoint } from "./endpoint.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";

export interface RuntimeStub {
  fetch(request: Request): Promise<Response>;
}
const Policy = Schema.Struct({
  pool: Schema.String,
  organization: Schema.String,
  revision: Schema.Number,
  expiresAt: Schema.Number,
  accounts: Schema.Array(Schema.String),
  dirty: Schema.Boolean,
});
const Health = Schema.Struct({
  identity: SlotIdentity,
  leaseMs: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1500)),
});
/** Convert remote remaining duration at dispatch, never a remote monotonic timestamp. */
export class BoundSlotDriver implements SlotDriver {
  private endpoint: (target: SlotTarget) => RuntimeStub;
  private driverId = crypto.randomUUID();
  private sequence = 0;
  private stubs = new WeakMap<RuntimeStub, number>();
  constructor(endpoint: (target: SlotTarget) => RuntimeStub) {
    this.endpoint = endpoint;
  }
  private async call(target: SlotTarget, action: string, value: unknown, signal: AbortSignal) {
    const request = new Request(`http://runtime/${action}`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    const trace = EndpointTrace.forRequest(request, target.slotId, this.driverId);
    let response: Response;
    try {
      response = await homeResponse(async () => {
        const runtimeStub = this.endpoint(target);
        let stub = this.stubs.get(runtimeStub);
        if (stub === undefined) {
          stub = ++this.sequence;
          this.stubs.set(runtimeStub, stub);
        }
        return trace.driverSend(stub, () => runtimeStub.fetch(request));
      }, signal);
      trace.finish(response);
    } catch (error) {
      trace.finish(error);
      throw error;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw retainRuntimeFailure(
        response,
        remoteRuntimeDefect(response) ?? new SlotRefused("uncertain"),
      );
    }
    return response;
  }
  private async read(target: SlotTarget, action: string, signal: AbortSignal): Promise<SlotHealth> {
    const requestedAt = performance.now();
    const response = await this.call(target, action, { target }, signal);
    try {
      const health = Schema.decodeUnknownSync(Health)(await response.json());
      const policyLeaseUntil = requestedAt + health.leaseMs;
      if (policyLeaseUntil <= performance.now()) throw new SlotRefused("unhealthy");
      return { identity: health.identity, policyLeaseUntil };
    } catch (error) {
      failEndpointResponse(response, error);
      throw error;
    }
  }
  async start(target: SlotTarget, signal: AbortSignal) {
    const response = await this.call(target, "start", { target }, signal);
    const started = Schema.decodeUnknownSync(Health)(await response.json());
    if (!sameTarget(started.identity, target)) throw new SlotRefused("identity");
    signal.throwIfAborted();
    // Cold startup is not health transport time. Acquire a fresh lease without repeating start.
    const health = await this.health(started.identity, signal);
    signal.throwIfAborted();
    if (!sameIdentity(health.identity, started.identity)) throw new SlotRefused("identity");
    return health;
  }
  warm(identity: SlotIdentity, signal: AbortSignal) {
    return this.read(identity, "warm", signal);
  }
  observe(target: SlotTarget, signal: AbortSignal) {
    return this.read(target, "observe", signal);
  }
  health(identity: SlotIdentity, signal: AbortSignal) {
    return this.read(identity, "health", signal);
  }
  async admit(target: SlotTarget, envelope: string) {
    await (
      await this.call(target, "admit", { envelope }, AbortSignal.timeout(5_000))
    ).body?.cancel();
  }
  async attest(target: SlotTarget, envelope: string) {
    await (
      await this.call(target, "attest", { envelope }, AbortSignal.timeout(5_000))
    ).body?.cancel();
  }
  async witness(target: SlotTarget) {
    return (await this.call(target, "witness", { target }, AbortSignal.timeout(2_000))).json();
  }
  async abortStartup(intent: StartupStopIntent, inspect: boolean) {
    const response = await this.call(
      intent.target,
      inspect ? "startup-abort-inspect" : "startup-abort",
      { intent },
      AbortSignal.timeout(5_000),
    );
    return Schema.decodeUnknownSync(StartupStopRecord)(await response.json());
  }
  async ready(identity: SlotIdentity, configurationFingerprint: string, imageInput: string) {
    const requestedAt = performance.now();
    const response = await this.call(
      identity,
      "ready",
      { identity, configurationFingerprint, imageInput },
      AbortSignal.timeout(2_000),
    );
    const health = Schema.decodeUnknownSync(Health)(await response.json());
    if (requestedAt + health.leaseMs <= performance.now()) throw new SlotRefused("unhealthy");
    return { identity: health.identity, policyLeaseUntil: requestedAt + health.leaseMs };
  }
  async install(identity: SlotIdentity, policy: NativeMembershipPolicy, signal: AbortSignal) {
    await (await this.call(identity, "install", { identity, policy }, signal)).body?.cancel();
  }
  async native(identity: SlotIdentity, policy: NativeMembershipPolicy, signal: AbortSignal) {
    await (await this.call(identity, "native", { identity, policy }, signal)).body?.cancel();
  }
  async retire(target: SlotTarget, identity: SlotIdentity, signal: AbortSignal) {
    const response = await this.call(target, "retire", { target, identity }, signal);
    await awaitProbe(() => response.body?.cancel() ?? Promise.resolve(), signal);
  }
  async drain(identity: SlotIdentity, signal: AbortSignal) {
    const response = await this.call(identity, "drain", { identity }, signal);
    return Schema.decodeUnknownSync(
      Schema.Struct({
        active: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
        known: Schema.Boolean,
      }),
    )(await response.json());
  }
  async retirement(identity: SlotIdentity, signal: AbortSignal) {
    const response = await this.call(identity, "retirement", { identity }, signal);
    return Schema.decodeUnknownSync(RuntimeRetirementObservation)(
      await retirementBody(response, signal),
    );
  }
  async failed(identity: SlotIdentity, signal: AbortSignal) {
    const response = await this.call(identity, "failed", { identity }, signal);
    return Schema.decodeUnknownSync(
      Schema.Struct({ identity: SlotIdentity, stopped: Schema.Boolean }),
    )(await retirementBody(response, signal));
  }
  fetch(identity: SlotIdentity, request: Request, port: 8317 | 8327 | 8318) {
    return this.forward(identity, request, port, false);
  }
  probeFetch(identity: SlotIdentity, request: Request, port: 8318 | 8327) {
    return this.forward(identity, request, port, true);
  }
  private async forward(
    identity: SlotIdentity,
    request: Request,
    port: 8317 | 8327 | 8318,
    readOnly: boolean,
  ) {
    const headers = new Headers(request.headers);
    headers.set("X-Signalbox-Runtime-Identity", JSON.stringify(identity));
    headers.set("X-Signalbox-Runtime-Port", String(port));
    if (readOnly) headers.set("X-Signalbox-Runtime-Read-Only", "1");
    else headers.delete("X-Signalbox-Runtime-Read-Only");
    const response = await this.endpoint(identity).fetch(new Request(request, { headers }));
    const defect = remoteRuntimeDefect(response);
    if ((response.status === 409 && runtimeResponseDiagnostic(response)) || defect) {
      void response.body?.cancel().catch(() => {});
      throw retainRuntimeFailure(response, defect ?? new SlotRefused("uncertain"));
    }
    return response;
  }
}

/** Only the pool Worker's private DO binding can reach this transport. */
export async function runtimeRequest(
  request: Request,
  endpoint: RuntimeEndpoint,
): Promise<Response> {
  try {
    const header = request.headers.get("X-Signalbox-Runtime-Identity");
    if (header !== null) {
      const identity = runtimeInput(() =>
        Schema.decodeUnknownSync(SlotIdentity)(JSON.parse(header)),
      );
      const port = Number(request.headers.get("X-Signalbox-Runtime-Port"));
      if (port !== 8317 && port !== 8318 && port !== 8327) throw new SlotRefused("identity");
      const headers = new Headers(request.headers);
      headers.delete("X-Signalbox-Runtime-Identity");
      headers.delete("X-Signalbox-Runtime-Port");
      const readOnly = headers.get("X-Signalbox-Runtime-Read-Only") === "1";
      headers.delete("X-Signalbox-Runtime-Read-Only");
      return await endpoint.fetch(identity, new Request(request, { headers }), port, readOnly);
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const text = await request.text();
    const value: unknown = runtimeInput(() => JSON.parse(text));
    const action = new URL(request.url).pathname;
    if (action === "/admit" || action === "/attest") {
      const { envelope } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(value),
      );
      if (action === "/admit") await endpoint.admit(envelope);
      else await endpoint.attest(envelope);
    } else if (action === "/startup-abort" || action === "/startup-abort-inspect") {
      const { intent } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ intent: StartupStopIntent }))(value),
      );
      return Response.json(
        action === "/startup-abort"
          ? await endpoint.abortStartup(intent, request.signal)
          : await endpoint.inspectStartupAbort(intent),
      );
    } else if (action === "/witness") {
      const { target } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ target: SlotTarget }))(value),
      );
      return Response.json(await endpoint.witness(target));
    } else if (action === "/ready") {
      const input = runtimeInput(() =>
        Schema.decodeUnknownSync(
          Schema.Struct({
            identity: SlotIdentity,
            configurationFingerprint: Schema.String,
            imageInput: Schema.String,
          }),
        )(value),
      );
      return Response.json(
        await endpoint.ready(input.identity, input.configurationFingerprint, input.imageInput),
      );
    } else if (
      action === "/start" ||
      action === "/observe" ||
      action === "/health" ||
      action === "/warm"
    ) {
      const { target } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ target: SlotTarget }))(value),
      );
      const observed =
        action === "/start"
          ? await endpoint.start(target, request.signal)
          : action === "/observe"
            ? await endpoint.observe(target, request.signal)
            : await endpoint[action === "/warm" ? "warm" : "health"](
                runtimeInput(() =>
                  Schema.decodeUnknownSync(Schema.Struct({ target: SlotIdentity }))(value),
                ).target,
                request.signal,
              );
      return Response.json(observed);
    } else if (action === "/install" || action === "/native") {
      const { identity, policy } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ identity: SlotIdentity, policy: Policy }))(value),
      );
      if (action === "/install") await endpoint.install(identity, policy, request.signal);
      else await endpoint.native(identity, policy, request.signal);
    } else if (action === "/drain") {
      const { identity } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ identity: SlotIdentity }))(value),
      );
      return Response.json(await endpoint.drain(identity, request.signal));
    } else if (action === "/retirement" || action === "/failed") {
      const { identity } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ identity: SlotIdentity }))(value),
      );
      return Response.json(
        await endpoint[action === "/failed" ? "failed" : "retirement"](identity, request.signal),
      );
    } else if (action === "/retire") {
      const { target, identity } = runtimeInput(() =>
        Schema.decodeUnknownSync(Schema.Struct({ target: SlotTarget, identity: SlotIdentity }))(
          value,
        ),
      );
      await endpoint.retire(target, identity, request.signal);
    } else return new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return runtimeErrorResponse(error, "endpoint");
  }
}

async function retirementBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  const cancel = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await awaitProbe(async () => {
      const decoder = new TextDecoder();
      let text = "";
      while (reader) {
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      signal.throwIfAborted();
      return JSON.parse(text + decoder.decode());
    }, signal);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
}
