import { homeResponse } from "../home-response.ts";
import { awaitProbe } from "../availability.ts";
import {
  retainRuntimeFailure,
  runtimeFailureHeaders,
  runtimeFailureDiagnostic,
  runtimeFailureCode,
} from "../runtime-route-diagnostic.ts";
import { Schema } from "effect";
import {
  SlotIdentity,
  SlotTarget,
  SlotRefused,
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
  constructor(endpoint: (target: SlotTarget) => RuntimeStub) {
    this.endpoint = endpoint;
  }
  private async call(target: SlotTarget, action: string, value: unknown, signal: AbortSignal) {
    const response = await homeResponse(
      () =>
        this.endpoint(target).fetch(
          new Request(`http://runtime/${action}`, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(value),
          }),
        ),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw retainRuntimeFailure(response, new SlotRefused("uncertain"));
    }
    return response;
  }
  private async read(target: SlotTarget, action: string, signal: AbortSignal): Promise<SlotHealth> {
    const requestedAt = performance.now();
    const response = await this.call(target, action, { target }, signal);
    const health = Schema.decodeUnknownSync(Health)(await response.json());
    const policyLeaseUntil = requestedAt + health.leaseMs;
    if (policyLeaseUntil <= performance.now()) throw new SlotRefused("unhealthy");
    return { identity: health.identity, policyLeaseUntil };
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
    return Schema.decodeUnknownSync(
      Schema.Struct({ identity: SlotIdentity, retired: Schema.Boolean, running: Schema.Boolean }),
    )(await retirementBody(response, signal));
  }
  fetch(identity: SlotIdentity, request: Request, port: 8317 | 8327 | 8318) {
    return this.forward(identity, request, port, false);
  }
  probeFetch(identity: SlotIdentity, request: Request, port: 8318 | 8327) {
    return this.forward(identity, request, port, true);
  }
  private forward(
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
    return this.endpoint(identity).fetch(new Request(request, { headers }));
  }
}

/** Only the pool Worker's private DO binding can reach this transport. */
export async function runtimeRequest(
  request: Request,
  endpoint: RuntimeEndpoint,
): Promise<Response> {
  try {
    const header = request.headers.get("X-Signalbox-Runtime-Identity");
    if (header) {
      const identity = Schema.decodeUnknownSync(SlotIdentity)(JSON.parse(header));
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
    const value: unknown = await request.json();
    const action = new URL(request.url).pathname;
    if (action === "/admit" || action === "/attest") {
      const { envelope } = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
        value,
      );
      if (action === "/admit") await endpoint.admit(envelope);
      else await endpoint.attest(envelope);
    } else if (action === "/witness") {
      const { target } = Schema.decodeUnknownSync(Schema.Struct({ target: SlotTarget }))(value);
      return Response.json(await endpoint.witness(target));
    } else if (action === "/ready") {
      const input = Schema.decodeUnknownSync(
        Schema.Struct({
          identity: SlotIdentity,
          configurationFingerprint: Schema.String,
          imageInput: Schema.String,
        }),
      )(value);
      return Response.json(
        await endpoint.ready(input.identity, input.configurationFingerprint, input.imageInput),
      );
    } else if (
      action === "/start" ||
      action === "/observe" ||
      action === "/health" ||
      action === "/warm"
    ) {
      const { target } = Schema.decodeUnknownSync(Schema.Struct({ target: SlotTarget }))(value);
      const observed =
        action === "/start"
          ? await endpoint.start(target, request.signal)
          : action === "/observe"
            ? await endpoint.observe(target, request.signal)
            : await endpoint[action === "/warm" ? "warm" : "health"](
                Schema.decodeUnknownSync(Schema.Struct({ target: SlotIdentity }))(value).target,
                request.signal,
              );
      return Response.json(observed);
    } else if (action === "/install" || action === "/native") {
      const { identity, policy } = Schema.decodeUnknownSync(
        Schema.Struct({ identity: SlotIdentity, policy: Policy }),
      )(value);
      if (action === "/install") await endpoint.install(identity, policy, request.signal);
      else await endpoint.native(identity, policy, request.signal);
    } else if (action === "/drain") {
      const { identity } = Schema.decodeUnknownSync(Schema.Struct({ identity: SlotIdentity }))(
        value,
      );
      return Response.json(await endpoint.drain(identity, request.signal));
    } else if (action === "/retirement") {
      const { identity } = Schema.decodeUnknownSync(Schema.Struct({ identity: SlotIdentity }))(
        value,
      );
      return Response.json(await endpoint.retirement(identity, request.signal));
    } else if (action === "/retire") {
      const { target, identity } = Schema.decodeUnknownSync(
        Schema.Struct({ target: SlotTarget, identity: SlotIdentity }),
      )(value);
      await endpoint.retire(target, identity, request.signal);
    } else return new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json(
      {
        error: "runtime-refused",
        reason: runtimeFailureCode(runtimeFailureDiagnostic(error, "endpoint_route")),
      },
      { status: 409, headers: runtimeFailureHeaders(error, "endpoint_route") },
    );
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
