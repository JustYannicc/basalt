import { RouteAccess, SelectInput, decode, metaKey } from "./access.ts";
import { RouteRefused, type GatewayContainer } from "./control.ts";
import { GatewayRuntime, type StartPurpose } from "./runtime.ts";
import {
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
  meta: metaKey,
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
const routed = new Set<Reading["state"]>(["active", "direct_fallback"]);

/** A reply whose call an intent event overtook; it writes nothing. */
class Stale extends Error {}

/**
 * One route's gateway as a state machine. The state is what storage holds: no identity (unjoined),
 * a pending sign-in, or a sealed identity with an exit selected (on) or none (off). The container
 * only caches it.
 *
 * Every intent event (sign-in start, choosing an exit, switching off, disconnect) advances
 * `epoch`. Each container call carries the epoch and the launch it began in, and its reply changes
 * state only through `commit`, which drops it if the epoch has moved. A commit writes storage and
 * nothing else; workerd delivers no other event while storage runs, so nothing slips between the
 * check and the write. Control calls go through one serial channel bound to their launch, so a call
 * queued before a stop never reaches the next container.
 *
 * Invariants:
 * - after a disconnect nothing from before it writes, and nothing starts except the one node that
 *   logs the device out;
 * - switching off always wins and answers without a container call;
 * - a route with no identity starts compute only to sign in;
 * - a late reply never changes a state it did not start from;
 * - a tunnel opens only while the latest reading is routed.
 */
export class RouteGatewayCore {
  private deps: GatewayDependencies;
  private runtime: GatewayRuntime;
  private access: RouteAccess;
  private identity: RouteIdentityStore;
  private epoch = 0;
  private refreshing: { epoch: number; promise: Promise<Reading> } | undefined;
  private leaving: Promise<void> | undefined;

  constructor(deps: GatewayDependencies) {
    this.deps = deps;
    this.identity = new RouteIdentityStore(deps.storage, deps.secret, deps.previousSecret);
    this.access = new RouteAccess(deps.storage, deps.name);
    this.runtime = new GatewayRuntime(
      deps.container,
      {
        epoch: () => this.epoch,
        plan: (since, purpose, identity) => this.plan(since, purpose, identity),
      },
      deps,
    );
  }

  async create(input: unknown): Promise<Record<string, never>> {
    await this.access.create(input);
    return {};
  }

  /** Sign-in start: a node (fresh, or the stored identity's) issues the person's approval link. */
  async login(input: unknown): Promise<{ url: string; expiresAt: number } | { state: "ready" }> {
    await this.access.authorize(input);
    await this.leaving;
    const since = ++this.epoch;
    // A node left from an ended sign-in may still hold a half-finished login; a new sign-in on an
    // unjoined route starts from a fresh one.
    if (
      this.runtime.running &&
      !(await this.identity.exists()) &&
      (await this.deps.storage.get(keys.loginUntil)) === undefined
    )
      await this.runtime.stop();
    try {
      const launch = await this.runtime.started(since, "sign-in");
      const reply = await this.runtime.call(launch, () => this.runtime.control.login());
      if (!("url" in reply)) return reply;
      const expiresAt = this.deps.now() + loginWindowMs;
      await this.commitOrRefuse(since, async () => {
        await this.deps.storage.put(keys.loginUntil, expiresAt);
        await this.schedule();
      });
      return { url: reply.url, expiresAt };
    } catch (error) {
      // A sign-in that failed leaves no node behind on a route with no identity to run it for.
      if (since === this.epoch && !(await this.identity.exists())) await this.runtime.stop();
      throw error;
    }
  }

  /** Whether the person has approved the device: a sealed identity exists and is still signed in. */
  async joinStatus(
    input: unknown,
  ): Promise<
    | { state: "waiting" }
    | { state: "connected"; tailnet: string | null }
    | { state: "failed"; reason: ReasonCode }
  > {
    await this.access.authorize(input);
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
    await this.access.authorize(input);
    // A route with no identity has no netmap to offer, and listing it must not start a node.
    if (!(await this.identity.exists())) throw new RouteRefused("route_needs_login");
    const launch = await this.runtime.started(this.epoch);
    const exits = await this.runtime.call(launch, () => this.runtime.control.exits());
    const selected = (await this.deps.storage.get<Selection>(keys.selection)) ?? {
      exitId: null,
      whenDown: "stop",
    };
    return { exits, selected: { exitId: selected.exitId, whenDown: selected.whenDown } };
  }

  /**
   * Switching off stores off and stops the gateway, with no container call, so it always wins and
   * answers at once; the next start applies off. Choosing an exit changes the stored selection only
   * when the gateway confirms it in the same epoch; otherwise it is refused and the previous
   * selection stays.
   */
  async select(caller: unknown, input: unknown): Promise<Reading> {
    await this.access.authorize(caller);
    const selection: Selection = decode(SelectInput, input);
    if (selection.exitId === null) {
      ++this.epoch;
      const signingIn = (await this.deps.storage.get(keys.loginUntil)) !== undefined;
      // Off and its reading are stored before any container work, so nothing reads it as routed.
      await this.deps.storage.put(keys.selection, selection);
      const reading = await this.record(await this.idle(selection), true);
      await this.schedule();
      // The gateway stops without the switch-off waiting for it. An open sign-in keeps its node,
      // and a disconnect in progress owns the container until its logout is done.
      if (!this.leaving && !signingIn) this.runtime.stop().catch(() => {});
      return reading;
    }
    // A route with no sealed identity has nothing to route through, and a node that is still
    // signing in must not be told to route either.
    if (!(await this.identity.exists())) throw new RouteRefused("route_needs_login");
    const since = ++this.epoch;
    let launch: number | undefined;
    let status: GatewayStatus | undefined;
    let reading: Reading;
    try {
      launch = await this.runtime.started(since);
      // The commit runs inside the call's slot on the channel, so the next call there (a heal, a
      // reconcile) already sees the choice it stored.
      reading = await this.runtime.call(launch, async () => {
        const applied = await this.runtime.control.select(selection);
        status = applied;
        return this.commit(since, async () => {
          await this.deps.storage.put(keys.selection, selection);
          return this.record(readingFromStatus(applied, this.deps.now()));
        });
      });
    } catch (error) {
      if (error instanceof Stale) {
        // An event overtook it after the gateway applied it: the gateway goes back to what storage
        // holds, through the same channel, so a newer choice queued after it still wins.
        this.runtime.reconcile(launch!, () => this.deps.storage.get<Selection>(keys.selection));
        throw new RouteRefused("route_gateway_unavailable");
      }
      // The gateway may have applied it anyway. A route that was off must not keep routing, so it
      // stops; otherwise the gateway is put back on what storage holds.
      const previous = await this.deps.storage.get<Selection>(keys.selection);
      if (since === this.epoch && (previous?.exitId ?? null) === null) await this.runtime.stop();
      else if (launch !== undefined)
        this.runtime.reconcile(launch, () => this.deps.storage.get<Selection>(keys.selection));
      throw error instanceof RouteRefused && error.reason === "route_needs_login"
        ? error
        : new RouteRefused("route_gateway_unavailable");
    }
    await this.persist(since, launch, status!);
    // An event that overtook it after the commit owns the outcome; the choice is not confirmed.
    if (since !== this.epoch) throw new RouteRefused("route_gateway_unavailable");
    await this.schedule();
    return reading;
  }

  async reading(input: unknown): Promise<Reading> {
    await this.access.authorize(input);
    return this.refresh();
  }

  /**
   * Disconnect writes first: the identity, selection and sign-in are gone before any container
   * call. Then one node logs the device out: the sign-in node already running, or a fresh one
   * started from the identity as it was. Every reply from before it is stale.
   */
  async disconnect(input: unknown): Promise<Record<string, never>> {
    const { routeId } = await this.access.authorize(input);
    await this.leaving;
    const since = ++this.epoch;
    const { state: captured } = await this.identity.open(routeId);
    const signingIn = captured === null && this.runtime.running;
    const launch = this.runtime.launch;
    await this.deps.storage.delete([keys.state, keys.selection, keys.loginUntil]);
    await this.deps.storage.deleteAlarm();
    await this.record(localReading("needs_login", "route_needs_login", undefined, this.deps.now()));
    const leaving = this.logOut(since, launch, signingIn, captured);
    const tracked: Promise<void> = leaving.finally(() => {
      if (this.leaving === tracked) this.leaving = undefined;
    });
    this.leaving = tracked;
    await tracked;
    return {};
  }

  /** The socket to the gateway's SOCKS port for one tunnel; the DO never parses what it carries. */
  async openTunnel(caller: { owner: string }) {
    if (caller.owner !== (await this.access.owner())) throw new RouteRefused("route_not_permitted");
    // The tunnel belongs to the epoch it began in: a switch-off or disconnect after it starts
    // nothing for it.
    const since = this.epoch;
    // Only a signed-in route with an exit selected may start compute for traffic.
    if (!(await this.routing())) throw new RouteRefused("route_gateway_unavailable");
    // A tunnel goes to the pool only while the latest reading is routed. One that is not is read
    // again first, so a route that recovered opens at once and one that is down never does.
    const last = await this.deps.storage.get<Reading>(keys.reading);
    if (!last || !routed.has(last.state)) {
      const fresh = await this.refresh();
      if (!routed.has(fresh.state)) throw new RouteRefused("route_gateway_unavailable");
    }
    try {
      const launch = await this.runtime.started(since);
      this.runtime.live(launch);
      return await this.runtime.control.connect();
    } catch {
      throw new RouteRefused("route_gateway_unavailable");
    }
  }

  async alarm() {
    if ((await this.access.owner()) === undefined) return;
    await this.refresh();
    const loginUntil = await this.deps.storage.get<number>(keys.loginUntil);
    if (loginUntil !== undefined && this.deps.now() >= loginUntil) await this.endSignIn();
    if (await this.routing()) await this.runtime.control.keepWarm(warmForMs);
    await this.schedule();
  }

  /**
   * The sign-in window ended unapproved: the window goes, and a node that never sealed an identity
   * is logged out and stopped, like a cancel, so a late approval cannot leave a device behind.
   */
  private async endSignIn() {
    const since = ++this.epoch;
    await this.deps.storage.delete([keys.loginUntil]);
    if (await this.identity.exists()) return;
    if (this.runtime.running) {
      const launch = this.runtime.launch;
      await this.runtime.call(launch, () => this.runtime.control.logout()).catch(() => {});
    }
    if (since === this.epoch) await this.runtime.stop();
  }

  private async logOut(since: number, launch: number, signingIn: boolean, captured: string | null) {
    try {
      if (signingIn) await this.runtime.call(launch, () => this.runtime.control.logout());
    } catch {
      console.log(JSON.stringify({ route_logout: "route_gateway_unavailable" }));
    }
    await this.runtime.stop();
    if (captured === null) return;
    try {
      const logoutLaunch = await this.runtime.started(since, "route", captured);
      await this.runtime.call(logoutLaunch, () => this.runtime.control.logout());
    } catch {
      // The device stays listed in the owner's tailnet until its key expires.
      console.log(JSON.stringify({ route_logout: "route_gateway_unavailable" }));
    }
    await this.runtime.stop();
  }

  /** Routing is on while a signed-in route has an exit selected; only then is it warmed and polled. */
  private async routing() {
    const exitId = (await this.deps.storage.get<Selection>(keys.selection))?.exitId ?? null;
    return exitId !== null && (await this.identity.exists());
  }

  /** The one place a container reply changes state. Its writes are storage only. */
  private async commit<T>(since: number, writes: () => Promise<T>): Promise<T> {
    if (since !== this.epoch) throw new Stale();
    return writes();
  }

  private async commitOrRefuse<T>(since: number, writes: () => Promise<T>): Promise<T> {
    try {
      return await this.commit(since, writes);
    } catch (error) {
      if (error instanceof Stale) throw new RouteRefused("route_gateway_unavailable");
      throw error;
    }
  }

  /** Concurrent reads in one epoch share one refresh, so an outage costs one start, not one each. */
  private refresh(): Promise<Reading> {
    const epoch = this.epoch;
    if (this.refreshing?.epoch === epoch) return this.refreshing.promise;
    const promise: Promise<Reading> = this.refreshNow(epoch).finally(() => {
      if (this.refreshing?.promise === promise) this.refreshing = undefined;
    });
    this.refreshing = { epoch, promise };
    return promise;
  }

  private async refreshNow(since: number): Promise<Reading> {
    const selection = await this.deps.storage.get<Selection>(keys.selection);
    const signingIn = (await this.deps.storage.get(keys.loginUntil)) !== undefined;
    // A sign-in whose node died cannot complete: its link belongs to that node. The window ends and
    // nothing is launched to find that out.
    if (
      signingIn &&
      !this.leaving &&
      !this.runtime.running &&
      !this.runtime.isStarting &&
      !(await this.identity.exists())
    ) {
      await this.commit(since, () => this.deps.storage.delete([keys.loginUntil])).catch(() => {});
      return this.record(
        localReading("needs_login", "route_needs_login", selection, this.deps.now()),
      );
    }
    // A route that routes nothing and signs nobody in is read without starting compute. A node that
    // still runs is put back on what storage holds, through its own launch, so one that applied a
    // choice an event overtook converges without anything being started.
    if (!(await this.routing()) && (!signingIn || this.leaving)) {
      if (this.runtime.running && !this.leaving && (await this.identity.exists())) {
        await this.runtime
          .call(this.runtime.launch, () => this.heal(since, { off: true }))
          .catch(() => {});
      }
      return this.record(await this.idle(selection), true);
    }
    try {
      const launch = await this.runtime.started(since);
      const status = await this.runtime.call(launch, () => this.heal(since, { off: false }));
      await this.persist(since, launch, status);
      return await this.commit(since, () =>
        this.record(readingFromStatus(status, this.deps.now())),
      );
    } catch (error) {
      if (error instanceof Stale || since !== this.epoch) return this.current();
      return this.commit(since, () => this.record(this.failed(error, selection), true));
    }
  }

  /**
   * Reads the gateway and puts it back on what storage holds, all in one slot on the channel: a
   * selection the gateway lost (a failed select, a start that missed it) is re-sent, and storage is
   * read in the same slot, so a choice committed in an earlier slot is never undone. Runs inside
   * `call`, so it uses the control directly.
   */
  private async heal(since: number, { off }: { off: boolean }) {
    const observed = await this.runtime.control.status();
    const stored = await this.deps.storage.get<Selection>(keys.selection);
    const wanted = stored ?? (off ? { exitId: null, whenDown: "stop" as const } : undefined);
    if (since !== this.epoch || !wanted || matches(observed, wanted)) return observed;
    return this.runtime.control.select(wanted);
  }

  /** What a read that an event overtook answers: the state that event left. */
  private async current() {
    return (
      (await this.deps.storage.get<Reading>(keys.reading)) ??
      settle(undefined, await this.idle(await this.deps.storage.get<Selection>(keys.selection)))
    );
  }

  /** The node state is read only after a login or key change, and only while signed in. */
  private async persist(since: number, launch: number, status: GatewayStatus) {
    if (!status.node.logged_in) return;
    const { routeId } = await this.access.meta();
    try {
      if (!(await this.identity.holds(status.boot_id, status.state_revision))) {
        const reply = await this.runtime.call(launch, () => this.runtime.control.state());
        const sealed = await this.identity.seal(routeId, reply.state);
        await this.commit(since, () =>
          this.identity.save(sealed, status.boot_id, reply.state_revision),
        );
      }
      // Only a sealed identity ends the sign-in, so a failed read keeps the poll going.
      await this.commit(since, () => this.deps.storage.delete([keys.loginUntil]));
    } catch {
      // The gateway's answer still stands; the identity is read again on the next refresh.
    }
  }

  private async idle(selection: Selection | undefined) {
    return (await this.identity.exists())
      ? localReading("off", "route_off", selection, this.deps.now())
      : localReading("needs_login", "route_needs_login", selection, this.deps.now());
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
      const meta = await this.deps.storage.get<{ routeId: string }>(keys.meta);
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

  /**
   * What a fresh node boots with. A sign-in link belongs to the node that issued it, so a fresh
   * node ends a pending sign-in; a seal no key opens is forgotten. Only a sign-in may boot a node
   * with no identity.
   */
  private async plan(since: number, purpose: StartPurpose, identity: string | undefined) {
    if (identity !== undefined) return { state: identity, selection: undefined };
    const { routeId } = await this.access.meta();
    const opened = await this.identity.open(routeId);
    if (opened.state !== null && opened.reseal) {
      const sealed = await this.identity.seal(routeId, opened.state);
      await this.commit(since, () => this.identity.reseal(sealed)).catch(() => {});
    }
    if (opened.state === null) {
      await this.commit(since, () =>
        this.deps.storage.delete(
          opened.unreadable ? [keys.loginUntil, keys.state] : [keys.loginUntil],
        ),
      ).catch(() => {});
      if (purpose === "route") return { refuse: "route_needs_login" as const };
    }
    return {
      state: opened.state,
      selection: await this.deps.storage.get<Selection>(keys.selection),
    };
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
