import { Schema } from "effect";
import { GatewayControl, RouteRefused, type GatewayContainer } from "./control.ts";
import {
  WhenDown,
  crossesDown,
  localReading,
  readingFromStatus,
  settle,
  routeReadingChanged,
  type GatewayStatus,
  type ReasonCode,
  type Observed,
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
/** Malformed input crosses the RPC boundary as a reason code, never as schema text. */
function decode<T, E>(schema: Schema.Codec<T, E>, input: unknown): T {
  try {
    return Schema.decodeUnknownSync(schema, strict)(input);
  } catch {
    throw new RouteRefused("route_not_permitted");
  }
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
  private refreshing: Promise<Reading> | undefined;
  private selecting: Promise<unknown> = Promise.resolve();
  /** Bumped by disconnect, so a call it overtook writes nothing after it. */
  private generation = 0;
  private deps: GatewayDependencies;
  private gateway: GatewayControl;
  private identity: RouteIdentityStore;
  constructor(deps: GatewayDependencies) {
    this.deps = deps;
    this.gateway = new GatewayControl(deps.container);
    this.identity = new RouteIdentityStore(deps.storage, deps.secret, deps.previousSecret);
  }

  async create(input: unknown): Promise<Record<string, never>> {
    const next = decode(CreateInput, input);
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
    await this.authorize(input);
    const generation = this.generation;
    await this.ensureStarted();
    return this.exclusive(async () => {
      this.current(generation);
      const reply = await this.gateway.login();
      this.current(generation);
      if (!("url" in reply)) return reply;
      const expiresAt = this.deps.now() + loginWindowMs;
      await this.deps.storage.put(keys.loginUntil, expiresAt);
      await this.schedule();
      return { url: reply.url, expiresAt };
    });
  }

  /** Whether the person has approved the device: a sealed identity exists and is still signed in. */
  async joinStatus(
    input: unknown,
  ): Promise<
    | { state: "waiting" }
    | { state: "connected"; tailnet: string | null }
    | { state: "failed"; reason: ReasonCode }
  > {
    await this.authorize(input);
    const reading = await this.refresh();
    const signedOut =
      reading.reason === "route_needs_login" || reading.reason === "route_key_expired";
    if ((await this.identity.exists()) && !signedOut)
      return { state: "connected", tailnet: reading.tailnet };
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    if (loginUntil !== undefined && loginUntil > this.deps.now()) return { state: "waiting" };
    return { state: "failed", reason: reading.reason ?? "route_needs_login" };
  }

  async exits(input: unknown) {
    await this.authorize(input);
    // A route with no identity has no netmap to offer, and listing it must not start a node.
    if (!this.gateway.running && !(await this.identity.exists()))
      throw new RouteRefused("route_needs_login");
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

  /**
   * Choosing an exit that does not reach the gateway changes nothing and is refused, so the host
   * writes no rule for it. Switching off always succeeds within one control call and never waits
   * on a start: a gateway that is starting or misses it is stopped, and its next start applies off.
   */
  async select(caller: unknown, input: unknown): Promise<Reading> {
    await this.authorize(caller);
    const selection: Selection = decode(SelectInput, input);
    const generation = this.generation;
    if (selection.exitId === null) {
      const reading = await this.exclusive(async () => {
        await this.deps.storage.put(keys.selection, selection);
        if (this.starting) await this.gateway.destroy();
        else if (this.gateway.running)
          try {
            return await this.applied(await this.gateway.select(selection));
          } catch {
            await this.gateway.destroy();
          }
        return this.record(await this.idle(selection), true);
      });
      await this.schedule();
      return reading;
    }
    try {
      await this.ensureStarted();
    } catch {
      throw new RouteRefused("route_gateway_unavailable");
    }
    const reading = await this.exclusive(async () => {
      this.current(generation);
      const previous = await this.deps.storage.get<Selection>(keys.selection);
      await this.deps.storage.put(keys.selection, selection);
      let status: GatewayStatus;
      try {
        status = await this.gateway.select(selection);
      } catch {
        if (previous) await this.deps.storage.put(keys.selection, previous);
        else await this.deps.storage.delete([keys.selection]);
        // The gateway may have applied it anyway; a route that was off must not keep routing.
        if ((previous?.exitId ?? null) === null) await this.gateway.destroy();
        throw new RouteRefused("route_gateway_unavailable");
      }
      return this.applied(status);
    });
    await this.schedule();
    return reading;
  }

  async reading(input: unknown): Promise<Reading> {
    await this.authorize(input);
    return this.refresh();
  }

  async disconnect(input: unknown): Promise<Record<string, never>> {
    await this.authorize(input);
    // Every sign-in, selection and refresh already in flight is now stale and writes nothing.
    this.generation += 1;
    // With no stored identity and nothing running there is no device to log out, so a repeated
    // disconnect starts no compute.
    if (this.gateway.running || (await this.identity.exists()))
      await this.ensureStarted().catch(() => {});
    return this.exclusive(async () => {
      try {
        if (this.gateway.running) await this.gateway.logout();
      } catch {
        // The device stays listed, offline, in the owner's tailnet until it expires. Disconnecting
        // must still finish, so the identity is forgotten here either way.
        console.log(JSON.stringify({ route_logout: "route_gateway_unavailable" }));
      }
      await this.deps.storage.delete([keys.state, keys.selection, keys.loginUntil]);
      await this.deps.storage.deleteAlarm();
      await this.gateway.destroy();
      await this.record(
        localReading("needs_login", "route_needs_login", undefined, this.deps.now()),
      );
      return {};
    });
  }

  /** The socket to the gateway's SOCKS port for one tunnel; the DO never parses what it carries. */
  async openTunnel(caller: { owner: string }) {
    const meta = await this.deps.storage.get<RouteMeta>(keys.meta);
    if (!meta || caller.owner !== meta.owner) throw new RouteRefused("route_not_permitted");
    // Only a signed-in route with an exit selected may start compute for traffic; anything else
    // could only be refused by the gateway, so it is refused here without a start.
    if (!this.gateway.running && (!(await this.identity.exists()) || !(await this.routing())))
      throw new RouteRefused("route_gateway_unavailable");
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
    if (await this.routing()) await this.gateway.keepWarm(warmForMs);
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
   * account, organization or person, and any malformed caller, is refused alike.
   */
  private async authorize(input: unknown) {
    const caller: RouteCaller = decode(Caller, input);
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

  /** Refuses the rest of a call that a disconnect overtook. */
  private current(generation: number) {
    if (generation !== this.generation) throw new RouteRefused("route_gateway_unavailable");
  }

  /** Routing is on while an exit is selected; only then is the gateway kept warm and polled. */
  private async routing() {
    return ((await this.deps.storage.get<Selection>(keys.selection))?.exitId ?? null) !== null;
  }

  /** Concurrent reads share one refresh, so an outage costs one start attempt, not one per caller. */
  private refresh(): Promise<Reading> {
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshNow(): Promise<Reading> {
    const live =
      this.gateway.running ||
      (await this.routing()) ||
      (await this.deps.storage.get(keys.loginUntil)) !== undefined;
    // A stopped gateway that routes nothing is read without starting compute.
    if (!live)
      return this.exclusive(async () =>
        this.record(await this.idle(await this.deps.storage.get<Selection>(keys.selection)), true),
      );
    // The start runs outside the lock: a hung gateway must not hold up a switch-off behind it.
    const generation = this.generation;
    const started = await this.ensureStarted().then(
      () => undefined,
      (error: unknown) => error ?? new Error("start failed"),
    );
    return this.exclusive(async () => {
      const selection = await this.deps.storage.get<Selection>(keys.selection);
      if (generation !== this.generation || (selection?.exitId === null && !this.gateway.running))
        return this.record(await this.idle(selection), true);
      try {
        if (started) throw started;
        const observed = await this.gateway.status();
        // A select the gateway lost (a failed boot-time select) is re-sent.
        const status =
          selection && !matches(observed, selection)
            ? await this.gateway.select(selection)
            : observed;
        await this.persistState(status);
        return this.record(readingFromStatus(status, this.deps.now()));
      } catch (error) {
        return this.record(this.failed(error, selection), true);
      }
    });
  }

  private async applied(status: GatewayStatus) {
    await this.persistState(status);
    return this.record(readingFromStatus(status, this.deps.now()));
  }

  private async idle(selection: Selection | undefined) {
    return (await this.identity.exists())
      ? localReading("off", "route_off", selection, this.deps.now())
      : localReading("needs_login", "route_needs_login", selection, this.deps.now());
  }

  /**
   * Every state write that follows a gateway reply (sign-in, selection, disconnect, each refresh
   * with its heal and identity save) runs one at a time. Starts stay outside it, so a lock holder
   * waits on at most a few bounded control calls, never a container start.
   */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.selecting.then(work, work);
    this.selecting = run.catch(() => {});
    return run;
  }

  private failed(error: unknown, selection: Selection | undefined) {
    const reason = error instanceof RouteRefused ? error.reason : "route_gateway_unavailable";
    return localReading("down", reason, selection, this.deps.now());
  }

  /**
   * A reading made without the gateway (cold or unreachable) keeps the node's own names and key
   * expiry from the last one while its identity is stored, so a switched-off route keeps its label
   * and the device id that Disconnect removes.
   */
  private async record(observed: Observed, local = false): Promise<Reading> {
    const previous = await this.deps.storage.get<Reading>(keys.reading);
    const known = local && previous && (await this.identity.exists()) ? previous : undefined;
    const reading = settle(previous, {
      ...observed,
      tailnet: observed.tailnet ?? known?.tailnet ?? null,
      deviceName: observed.deviceName ?? known?.deviceName ?? null,
      deviceId: observed.deviceId ?? known?.deviceId ?? null,
      keyExpiry: observed.keyExpiry ?? known?.keyExpiry ?? null,
    });
    await this.deps.storage.put(keys.reading, reading);
    if (crossesDown(previous, reading)) {
      const meta = await this.deps.storage.get<RouteMeta>(keys.meta);
      if (meta) this.deps.emit(routeReadingChanged(meta.routeId, reading));
    }
    return reading;
  }

  private async schedule() {
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    const now = this.deps.now();
    if (loginUntil !== undefined && loginUntil > now)
      await this.deps.storage.setAlarm(now + loginPollMs);
    else if (await this.routing()) await this.deps.storage.setAlarm(now + statusPollMs);
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
    if (!(await this.identity.holds(status.boot_id, status.state_revision))) {
      const { routeId } = await this.meta();
      const reply = await this.gateway.state();
      await this.identity.save(routeId, reply.state, status.boot_id, reply.state_revision);
    }
    // Only a saved identity ends the sign-in, so a failed state read keeps the poll going.
    await this.deps.storage.delete([keys.loginUntil]);
  }
}

/**
 * Whether the gateway runs the stored selection. While the chosen exit is missing the gateway
 * reports no exit, so the select is re-sent each poll; it is idempotent.
 */
function matches(status: GatewayStatus, selection: Selection) {
  if (status.when_down !== selection.whenDown) return false;
  if (selection.exitId === null) return status.reason === "route_off";
  return status.exit?.id === selection.exitId;
}
