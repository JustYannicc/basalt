import { Schema } from "effect";
import { GatewayControl, RouteRefused, type GatewayContainer } from "./control.ts";
import {
  WhenDown,
  crossesDown,
  localReading,
  readingFromStatus,
  routeReadingChanged,
  type GatewayStatus,
  type ReasonCode,
  type Reading,
  type RouteReadingChanged,
  type Selection,
} from "./reading.ts";
import { RouteIdentityStore, routeStateKey } from "./state.ts";
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
const strict = { onExcessProperty: "error" } as const;

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
  state: routeStateKey,
  selection: "route-v1:selection",
  reading: "route-v1:reading",
  loginUntil: "route-v1:login-until",
} as const;
const loginPollMs = 2_000;
const loginWindowMs = 10 * 60_000;
const statusPollMs = 30_000;
// Each 30 s alarm pushes this out again, so only a stopped alarm lets a selected route sleep.
const warmForMs = 10 * 60_000;
const startDeadlineMs = 30_000;

export class RouteGatewayCore {
  private starting: Promise<void> | undefined;
  private deps: GatewayDependencies;
  private gateway: GatewayControl;
  private identity: RouteIdentityStore;
  constructor(deps: GatewayDependencies) {
    this.deps = deps;
    this.gateway = new GatewayControl(deps.container);
    this.identity = new RouteIdentityStore(deps.storage, deps.secret, deps.previousSecret);
  }

  async create(input: unknown): Promise<Record<string, never>> {
    const next = Schema.decodeUnknownSync(CreateInput, strict)(input);
    if (this.deps.name !== undefined && this.deps.name !== next.routeId)
      throw new RouteRefused("route_not_permitted");
    const current = await this.deps.storage.get<RouteMeta>(keys.meta);
    if (current) {
      if (
        current.routeId !== next.routeId ||
        current.owner !== next.owner ||
        current.app !== next.app
      )
        throw new RouteRefused("route_not_permitted");
      return {};
    }
    await this.deps.storage.put(keys.meta, { ...next, account: null } satisfies RouteMeta);
    return {};
  }

  async login(input: unknown): Promise<{ url: string; expiresAt: number } | { state: "ready" }> {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    await this.ensureStarted();
    const reply = await this.gateway.login();
    if (!("url" in reply)) return reply;
    const expiresAt = this.deps.now() + loginWindowMs;
    await this.deps.storage.put(keys.loginUntil, expiresAt);
    await this.schedule();
    return { url: reply.url, expiresAt };
  }

  /** Whether the person has approved the device: a sealed identity exists and is still signed in. */
  async joinStatus(
    input: unknown,
  ): Promise<
    | { state: "waiting" }
    | { state: "connected"; tailnet: string | null }
    | { state: "failed"; reason: ReasonCode }
  > {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    const { reading } = await this.refresh();
    const signedOut =
      reading.reason === "route_needs_login" || reading.reason === "route_key_expired";
    if ((await this.identity.exists()) && !signedOut)
      return { state: "connected", tailnet: reading.tailnet };
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    if (loginUntil !== undefined && loginUntil > this.deps.now()) return { state: "waiting" };
    return { state: "failed", reason: reading.reason ?? "route_needs_login" };
  }

  async exits(input: unknown) {
    await this.authorize(Schema.decodeUnknownSync(Caller, strict)(input));
    await this.ensureStarted();
    const exits = await this.gateway.exits();
    const selected = (await this.deps.storage.get<Selection>(keys.selection)) ?? {
      exitId: null,
      whenDown: "stop",
    };
    return {
      exits,
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
      const status = await this.gateway.select(selection);
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
    // With no stored identity and nothing running there is no device to log out, so a repeated
    // disconnect starts no compute.
    const identity = this.gateway.running || (await this.identity.exists());
    try {
      if (identity) {
        await this.ensureStarted();
        await this.gateway.logout();
      }
    } catch {
      // The device stays listed, offline, in the owner's tailnet until it expires. Disconnecting
      // must still finish, so the identity is forgotten here either way.
      console.log(JSON.stringify({ route_logout: "route_gateway_unavailable" }));
    }
    await this.deps.storage.delete([keys.state, keys.selection, keys.loginUntil]);
    await this.deps.storage.deleteAlarm();
    await this.gateway.destroy();
    await this.record(localReading("needs_login", "route_needs_login", undefined, this.deps.now()));
    return {};
  }

  /** The socket to the gateway's SOCKS port for one tunnel; the DO never parses what it carries. */
  async openTunnel(caller: { owner: string }) {
    const meta = await this.deps.storage.get<RouteMeta>(keys.meta);
    if (!meta || caller.owner !== meta.owner) throw new RouteRefused("route_not_permitted");
    try {
      await this.ensureStarted();
    } catch {
      throw new RouteRefused("route_gateway_unavailable");
    }
    return this.gateway.connect();
  }

  async alarm() {
    if (!(await this.deps.storage.get<RouteMeta>(keys.meta))) return;
    await this.refresh();
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    if (loginUntil !== undefined && this.deps.now() >= loginUntil)
      await this.deps.storage.delete([keys.loginUntil]);
    if (await this.deps.storage.get(keys.selection)) await this.gateway.keepWarm(warmForMs);
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
    if (meta.owner.split("/")[1] !== caller.organization)
      throw new RouteRefused("route_not_permitted");
    if (meta.account === null)
      await this.deps.storage.put(keys.meta, {
        ...meta,
        account: caller.account,
      } satisfies RouteMeta);
    else if (meta.account !== caller.account) throw new RouteRefused("route_not_permitted");
    return meta;
  }

  private async refresh(): Promise<{ reading: Reading }> {
    const selection = await this.deps.storage.get<Selection>(keys.selection);
    const live =
      this.gateway.running ||
      selection !== undefined ||
      (await this.identity.exists()) ||
      (await this.deps.storage.get(keys.loginUntil)) !== undefined;
    if (!live) {
      // Nothing to restore: a logged-out node, read without starting compute.
      const reading = localReading("needs_login", "route_needs_login", selection, this.deps.now());
      await this.record(reading);
      return { reading };
    }
    try {
      await this.ensureStarted();
      const status = await this.gateway.status();
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
    this.gateway.launch();
    const deadline = this.deps.now() + startDeadlineMs;
    for (;;) {
      const probe = await this.gateway.probe();
      if (probe === "started") return;
      if (probe === "unstarted") return this.boot();
      if (this.deps.now() >= deadline) throw new RouteRefused("route_gateway_unavailable");
      await this.deps.sleep(250);
    }
  }

  private async boot() {
    const { routeId } = await this.meta();
    await this.gateway.start(await this.identity.open(routeId));
    const selection = await this.deps.storage.get<Selection>(keys.selection);
    if (selection) await this.gateway.select(selection);
  }

  /** The node state is read only after a login or key change, and only while signed in. */
  private async persistState(status: GatewayStatus) {
    if (!status.node.logged_in) return;
    await this.deps.storage.delete([keys.loginUntil]);
    if (await this.identity.holds(status.boot_id, status.state_revision)) return;
    const { routeId } = await this.meta();
    const reply = await this.gateway.state();
    await this.identity.save(routeId, reply.state, status.boot_id, reply.state_revision);
  }
}
