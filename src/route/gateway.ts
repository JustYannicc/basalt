import { Schema } from "effect";
import {
  GatewayStatus,
  ReasonCode,
  WhenDown,
  crossesDown,
  localReading,
  readingFromStatus,
  routeReadingChanged,
  type Reading,
  type RouteReadingChanged,
  type Selection,
} from "./reading.ts";
import { openRouteState, sealRouteState, type SealedRouteState } from "./state.ts";
import { routeIdPattern, routeOwnerPattern } from "./acquisition-contract.ts";

export { routeIdPattern };
export const RouteId = Schema.String.check(Schema.isPattern(routeIdPattern));
const Opaque = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const RouteOwner = Opaque.check(Schema.isPattern(routeOwnerPattern));

export const RouteMeta = Schema.Struct({
  routeId: RouteId,
  owner: RouteOwner,
  app: Opaque,
  // The host saves the account only after the sign-in connects; its first account step binds it.
  account: Schema.NullOr(Opaque),
});
export type RouteMeta = typeof RouteMeta.Type;
/** A person during sign-in, or a saved account in its organization when no person is present. */
const Caller = Schema.Union([
  Schema.Struct({ routeId: RouteId, owner: RouteOwner }),
  Schema.Struct({ routeId: RouteId, organization: Opaque, account: Opaque }),
]);
export type RouteCaller = typeof Caller.Type;
const CreateInput = Schema.Struct({ routeId: RouteId, owner: RouteOwner, app: Opaque });
const SelectInput = Schema.Struct({ exitId: Schema.NullOr(Opaque), whenDown: WhenDown });
const LoginReply = Schema.Union([
  Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^https:\/\//u)) }),
  Schema.Struct({ state: Schema.Literal("ready") }),
]);
const ExitsReply = Schema.Struct({
  exits: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, online: Schema.Boolean })),
});
const StateReply = Schema.Struct({ state: Schema.String, state_revision: Schema.Number });
const strict = { onExcessProperty: "error" } as const;

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

export interface GatewayStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(keys: string[]): Promise<number>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface GatewayDependencies {
  storage: GatewayStorage;
  container: GatewayContainer | undefined;
  /** The name the DO was addressed by, when the platform reports it. */
  name: string | undefined;
  secret: string;
  previousSecret: string | undefined;
  now(): number;
  sleep(ms: number): Promise<void>;
  emit(event: RouteReadingChanged): void;
}

const keys = {
  meta: "route-v1:meta",
  state: "route-v1:state",
  selection: "route-v1:selection",
  reading: "route-v1:reading",
  loginUntil: "route-v1:login-until",
} as const;
interface StoredState {
  sealed: SealedRouteState;
  bootId: string;
  revision: number;
}
const controlPort = 8080;
const socksPort = 1080;
const loginPollMs = 2_000;
const loginWindowMs = 10 * 60_000;
const statusPollMs = 30_000;
// Each 30 s alarm pushes this out again, so only a stopped alarm lets a selected route sleep.
const warmForMs = 10 * 60_000;
const startDeadlineMs = 30_000;
const controlTimeoutMs = 5_000;

export class RouteGatewayCore {
  private starting: Promise<void> | undefined;
  private deps: GatewayDependencies;
  constructor(deps: GatewayDependencies) {
    this.deps = deps;
  }

  async create(input: unknown): Promise<Record<string, never>> {
    const next = Schema.decodeUnknownSync(CreateInput, strict)(input);
    if (this.deps.name !== undefined && this.deps.name !== next.routeId)
      throw new RouteRefused("route_not_permitted");
    const current = await this.deps.storage.get<RouteMeta>(keys.meta);
    if (current) {
      if (current.routeId !== next.routeId || current.owner !== next.owner || current.app !== next.app)
        throw new RouteRefused("route_not_permitted");
      return {};
    }
    await this.deps.storage.put(keys.meta, { ...next, account: null } satisfies RouteMeta);
    return {};
  }

  async login(input: unknown): Promise<{ url: string; expiresAt: number } | { state: "ready" }> {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    await this.ensureStarted();
    const reply = Schema.decodeUnknownSync(LoginReply)(await this.control("POST", "/login", {}));
    if (!("url" in reply)) return reply;
    const expiresAt = this.deps.now() + loginWindowMs;
    await this.deps.storage.put(keys.loginUntil, expiresAt);
    await this.schedule();
    return { url: reply.url, expiresAt };
  }

  /** Whether the person has approved the device: a sealed identity exists and is still signed in. */
  async joinStatus(
    input: unknown,
  ): Promise<{ state: "waiting" } | { state: "connected"; tailnet: string | null } | { state: "failed"; reason: ReasonCode }> {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    const { reading } = await this.refresh();
    const signedOut = reading.reason === "route_needs_login" || reading.reason === "route_key_expired";
    if ((await this.deps.storage.get(keys.state)) !== undefined && !signedOut)
      return { state: "connected", tailnet: reading.tailnet };
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    if (loginUntil !== undefined && loginUntil > this.deps.now()) return { state: "waiting" };
    return { state: "failed", reason: reading.reason ?? "route_needs_login" };
  }

  async exits(input: unknown) {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    await this.ensureStarted();
    const reply = Schema.decodeUnknownSync(ExitsReply)(await this.control("GET", "/exits"));
    const selected = (await this.deps.storage.get<Selection>(keys.selection)) ?? {
      exitId: null,
      whenDown: "stop",
    };
    return {
      exits: reply.exits.map(({ id, name, online }) => ({ id, name, online })),
      selected: { exitId: selected.exitId, whenDown: selected.whenDown },
    };
  }

  async select(caller: unknown, input: unknown): Promise<Reading> {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(caller));
    const selection: Selection = Schema.decodeUnknownSync(SelectInput, strict)(input);
    await this.deps.storage.put(keys.selection, selection);
    let reading: Reading;
    try {
      await this.ensureStarted();
      const status = await this.selectOn(selection);
      await this.persistState(status);
      reading = readingFromStatus(status, this.deps.now());
    } catch (error) {
      reading = this.failed(error, selection);
    }
    await this.record(reading);
    await this.schedule();
    return reading;
  }

  async reading(input: unknown): Promise<Reading> {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    return (await this.refresh()).reading;
  }

  async disconnect(input: unknown): Promise<Record<string, never>> {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    const container = this.deps.container;
    // With no stored identity and nothing running there is no device to log out, so a repeated
    // disconnect starts no compute.
    const identity = container?.running || (await this.deps.storage.get(keys.state)) !== undefined;
    try {
      if (identity) {
        await this.ensureStarted();
        await this.control("POST", "/logout", {});
      }
    } catch {
      // The device stays listed, offline, in the owner's tailnet until it expires. Disconnecting
      // must still finish, so the identity is forgotten here either way.
      console.log(JSON.stringify({ route_logout: "route_gateway_unavailable" }));
    }
    await this.deps.storage.delete([keys.state, keys.selection, keys.loginUntil]);
    await this.deps.storage.deleteAlarm();
    if (container?.running) await container.destroy().catch(() => {});
    await this.record(localReading("needs_login", "route_needs_login", undefined, this.deps.now()));
    return {};
  }

  /** The socket to the gateway's SOCKS port for one tunnel; the DO never parses what it carries. */
  async openTunnel(caller: { owner: string }): Promise<GatewaySocket> {
    const meta = await this.deps.storage.get<RouteMeta>(keys.meta);
    if (!meta || caller.owner !== meta.owner)
      throw new RouteRefused("route_not_permitted");
    try {
      await this.ensureStarted();
      const socket = this.deps.container!.getTcpPort(socksPort).connect(`127.0.0.1:${socksPort}`, {
        allowHalfOpen: true,
      });
      await socket.opened;
      return socket;
    } catch {
      throw new RouteRefused("route_gateway_unavailable");
    }
  }

  async alarm() {
    if (!(await this.deps.storage.get<RouteMeta>(keys.meta))) return;
    await this.refresh();
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    if (loginUntil !== undefined && this.deps.now() >= loginUntil)
      await this.deps.storage.delete([keys.loginUntil]);
    if ((await this.deps.storage.get(keys.selection)) && this.deps.container?.running)
      await this.deps.container.setInactivityTimeout(warmForMs).catch(() => {});
    await this.schedule();
  }

  private async meta() {
    const meta = await this.deps.storage.get<RouteMeta>(keys.meta);
    if (!meta) throw new RouteRefused("route_not_permitted");
    return meta;
  }

  /**
   * Every call names its route and either the person who started it or, for a saved account, that
   * account in the owner's organization. The first account step binds the account; any other
   * account, organization or person is refused alike.
   */
  private async authorize(caller: RouteCaller) {
    const meta = await this.meta();
    if (meta.routeId !== caller.routeId) throw new RouteRefused("route_not_permitted");
    if ("owner" in caller) {
      if (meta.owner !== caller.owner) throw new RouteRefused("route_not_permitted");
      return meta;
    }
    if (meta.owner.split("/")[1] !== caller.organization) throw new RouteRefused("route_not_permitted");
    if (meta.account === null)
      await this.deps.storage.put(keys.meta, { ...meta, account: caller.account } satisfies RouteMeta);
    else if (meta.account !== caller.account) throw new RouteRefused("route_not_permitted");
    return meta;
  }

  private async refresh(): Promise<{ reading: Reading }> {
    const selection = await this.deps.storage.get<Selection>(keys.selection);
    const live =
      this.deps.container?.running ||
      selection !== undefined ||
      (await this.deps.storage.get(keys.state)) !== undefined ||
      (await this.deps.storage.get(keys.loginUntil)) !== undefined;
    if (!live) {
      // Nothing to restore: a logged-out node, read without starting compute.
      const reading = localReading("needs_login", "route_needs_login", selection, this.deps.now());
      await this.record(reading);
      return { reading };
    }
    try {
      await this.ensureStarted();
      const status = Schema.decodeUnknownSync(GatewayStatus)(await this.control("GET", "/status"));
      await this.persistState(status);
      const reading = readingFromStatus(status, this.deps.now());
      await this.record(reading);
      return { reading };
    } catch (error) {
      const reading = this.failed(error, selection);
      await this.record(reading);
      return { reading };
    }
  }

  private failed(error: unknown, selection: Selection | undefined) {
    const reason = error instanceof RouteRefused ? error.reason : "route_gateway_unavailable";
    return localReading("down", reason, selection, this.deps.now());
  }

  private async record(reading: Reading) {
    const previous = await this.deps.storage.get<Reading>(keys.reading);
    await this.deps.storage.put(keys.reading, reading);
    if (crossesDown(previous, reading)) {
      const meta = await this.deps.storage.get<RouteMeta>(keys.meta);
      if (meta) this.deps.emit(routeReadingChanged(meta.routeId, reading));
    }
  }

  private async schedule() {
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    const now = this.deps.now();
    if (loginUntil !== undefined && loginUntil > now)
      await this.deps.storage.setAlarm(now + loginPollMs);
    else if (await this.deps.storage.get(keys.selection))
      await this.deps.storage.setAlarm(now + statusPollMs);
    else await this.deps.storage.deleteAlarm();
  }

  private ensureStarted() {
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** Every container start gets the stored identity and selection before anything else reaches it. */
  private async start() {
    const container = this.deps.container;
    if (!container) throw new RouteRefused("route_gateway_unavailable");
    if (!container.running) container.start({ enableInternet: true });
    const deadline = this.deps.now() + startDeadlineMs;
    for (;;) {
      let response: Response | undefined;
      try {
        response = await this.request("GET", "/status");
      } catch {}
      if (response?.ok) return;
      if (response?.status === 409) {
        await response.body?.cancel();
        return this.boot();
      }
      await response?.body?.cancel();
      if (this.deps.now() >= deadline) throw new RouteRefused("route_gateway_unavailable");
      await this.deps.sleep(250);
    }
  }

  private async boot() {
    const meta = await this.meta();
    const stored = await this.deps.storage.get<StoredState>(keys.state);
    let state: string | null = null;
    if (stored) {
      try {
        const opened = await openRouteState(
          this.deps.secret,
          meta.routeId,
          stored.sealed,
          this.deps.previousSecret,
        );
        state = opened.state;
        if (opened.reseal)
          await this.deps.storage.put(keys.state, {
            ...stored,
            sealed: await sealRouteState(this.deps.secret, meta.routeId, state),
          });
      } catch {
        // Both keys are gone: the node starts logged out and the reading asks for a new sign-in.
        console.log(JSON.stringify({ route_state: "unreadable" }));
      }
    }
    const started = await this.request("POST", "/start", { state });
    await started.body?.cancel();
    if (!started.ok && started.status !== 409) throw new RouteRefused("route_gateway_unavailable");
    const selection = await this.deps.storage.get<Selection>(keys.selection);
    if (selection) await this.selectOn(selection);
  }

  private async selectOn(selection: Selection) {
    return Schema.decodeUnknownSync(GatewayStatus)(
      await this.control("POST", "/select", {
        exit_id: selection.exitId,
        when_down: selection.whenDown,
      }),
    );
  }

  /** The node state is read only after a login or key change, and only while signed in. */
  private async persistState(status: GatewayStatus) {
    if (!status.node.logged_in) return;
    await this.deps.storage.delete([keys.loginUntil]);
    const stored = await this.deps.storage.get<StoredState>(keys.state);
    if (stored && stored.bootId === status.boot_id && stored.revision === status.state_revision)
      return;
    const { routeId } = await this.meta();
    const reply = Schema.decodeUnknownSync(StateReply)(await this.control("GET", "/state"));
    await this.deps.storage.put(keys.state, {
      sealed: await sealRouteState(this.deps.secret, routeId, reply.state),
      bootId: status.boot_id,
      revision: reply.state_revision,
    } satisfies StoredState);
  }

  private request(method: string, path: string, body?: unknown) {
    const container = this.deps.container;
    if (!container) throw new RouteRefused("route_gateway_unavailable");
    return container.getTcpPort(controlPort).fetch(`http://route-gateway.internal${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(controlTimeoutMs),
    });
  }

  /** A control call's JSON body; a gateway refusal surfaces as its reason code only. */
  private async control(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(method, path, body);
    } catch {
      throw new RouteRefused("route_gateway_unavailable");
    }
    const value: unknown = await response.json().catch(() => undefined);
    if (response.ok) return value;
    const reason =
      value && typeof value === "object" && "error" in value ? (value as { error: unknown }).error : undefined;
    throw new RouteRefused(
      Schema.is(ReasonCode)(reason) ? reason : "route_gateway_unavailable",
    );
  }
}
