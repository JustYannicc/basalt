import { Option, Schema } from "effect";
import { GatewayStatus, ReasonCode, epochMs, type Selection } from "./reading.ts";

/** A refusal that crosses the RPC boundary: its message is the reason code and nothing else. */
export class RouteRefused extends Error {
  readonly reason: ReasonCode;
  constructor(reason: ReasonCode) {
    super(reason);
    this.reason = reason;
  }
}

export interface GatewaySocket {
  opened: Promise<unknown>;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

/** The slice of `ctx.container` the gateway uses; tests replace it with a fake. */
export interface GatewayContainer {
  readonly running: boolean;
  start(options: { enableInternet: boolean }): void;
  destroy(): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  getTcpPort(port: number): {
    fetch(input: string, init?: RequestInit): Promise<Response>;
    connect(address: string, options?: { allowHalfOpen: boolean }): GatewaySocket;
  };
}

const LoginReply = Schema.Union([
  Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^https:\/\//u)) }),
  Schema.Struct({ state: Schema.Literal("ready") }),
]);
const ExitsReply = Schema.Struct({
  exits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      online: Schema.Boolean,
      last_seen: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const StateReply = Schema.Struct({ state: Schema.String, state_revision: Schema.Number });
/** A reply the gateway should never send is refused by reason code; its text never travels on. */
function parse<T, E>(schema: Schema.Codec<T, E>, value: unknown): T {
  const decoded = Schema.decodeUnknownOption(schema)(value);
  if (Option.isNone(decoded)) throw new RouteRefused("route_gateway_unavailable");
  return decoded.value;
}
const controlPort = 8080;
const socksPort = 1080;
const timeoutMs = 5_000;

/**
 * The client of the gateway container's I1 wire, which the DO alone speaks: JSON control on 8080
 * and raw SOCKS bytes on 1080. Every failure surfaces as a reason code, never the gateway's text.
 */
export class GatewayControl {
  private container: GatewayContainer | undefined;
  constructor(container: GatewayContainer | undefined) {
    this.container = container;
  }

  get running() {
    return this.container?.running ?? false;
  }
  launch() {
    const container = this.present();
    if (!container.running) container.start({ enableInternet: true });
  }
  async destroy() {
    if (this.container?.running) await this.container.destroy().catch(() => {});
  }
  async keepWarm(durationMs: number) {
    if (this.container?.running)
      await this.container.setInactivityTimeout(durationMs).catch(() => {});
  }

  /** Whether the control port answers, and whether the node in it has been started yet. */
  async probe(): Promise<"started" | "unstarted" | "unreachable"> {
    let response: Response;
    try {
      response = await this.request("GET", "/status");
    } catch {
      return "unreachable";
    }
    await response.body?.cancel();
    return response.ok ? "started" : response.status === 409 ? "unstarted" : "unreachable";
  }
  /** A second start answers 409; the node is then already running, which is what was asked. */
  async start(state: string | null) {
    const response = await this.request("POST", "/start", { state }).catch(() => undefined);
    await response?.body?.cancel();
    if (!response || (!response.ok && response.status !== 409))
      throw new RouteRefused("route_gateway_unavailable");
  }
  async status() {
    return parse(GatewayStatus, await this.call("GET", "/status"));
  }
  async select(selection: Selection) {
    return parse(
      GatewayStatus,
      await this.call("POST", "/select", {
        exit_id: selection.exitId,
        when_down: selection.whenDown,
      }),
    );
  }
  async login() {
    return parse(LoginReply, await this.call("POST", "/login", {}));
  }
  async exits() {
    const reply = parse(ExitsReply, await this.call("GET", "/exits"));
    return reply.exits.map(({ id, name, online, last_seen }) => ({
      id,
      name,
      online,
      lastSeen: online ? null : epochMs(last_seen),
    }));
  }
  async logout() {
    await this.call("POST", "/logout", {});
  }
  async state() {
    return parse(StateReply, await this.call("GET", "/state"));
  }
  async connect() {
    try {
      const socket = this.present()
        .getTcpPort(socksPort)
        .connect(`127.0.0.1:${socksPort}`, { allowHalfOpen: true });
      await socket.opened;
      return socket;
    } catch {
      throw new RouteRefused("route_gateway_unavailable");
    }
  }

  private present() {
    if (!this.container) throw new RouteRefused("route_gateway_unavailable");
    return this.container;
  }
  private request(method: string, path: string, body?: unknown) {
    const controlPlane = this.present().getTcpPort(controlPort);
    return controlPlane.fetch(`http://route-gateway.internal${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(method, path, body);
    } catch {
      throw new RouteRefused("route_gateway_unavailable");
    }
    const value: unknown = await response.json().catch(() => undefined);
    if (response.ok) return value;
    const reason = value && typeof value === "object" && "error" in value ? value.error : undefined;
    throw new RouteRefused(Schema.is(ReasonCode)(reason) ? reason : "route_gateway_unavailable");
  }
}
