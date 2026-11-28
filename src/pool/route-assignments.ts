import { Option, Schema } from "effect";
import { readHomeConfigProxies, setHomeConfigProxy } from "./account-config-mirror.ts";
import type { HomeClient } from "./control.ts";
import { post, rows, unavailable } from "./json.ts";
import { routePeerAddress } from "./route-refusal.ts";

/** What the tools service answers for one credential: its contributor's rule, under that owner. */
export interface RouteResolution {
  readonly routeId: string | null;
  readonly owner: string | null;
}
export interface RouteScope {
  readonly organization: string;
  readonly pool: string;
}
export interface RouteAnswer {
  /** False only while the tools service does not serve route rules at all. */
  readonly served: boolean;
  readonly revision: number;
  readonly resolutions: ReadonlyMap<string, RouteResolution>;
}
/** I3 pool resolution: one pool's references at a time; an empty list is the revision poll. */
export interface RouteResolver {
  resolve(
    scope: RouteScope,
    references: readonly string[],
    signal: AbortSignal,
  ): Promise<RouteAnswer>;
}
/**
 * What the host knows about a mirrored credential's routing without a pool: whether its
 * contributor has any route rule, and that owner's account- and everything-level answer. Absent
 * fields, as from a host that serves no route rules, keep today's behaviour.
 */
export interface MirrorRouteHint {
  readonly hasRules?: boolean;
  readonly route?: RouteResolution | null;
}
export interface RouteStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<Map<string, unknown>>;
}

const routeId = /^rt_[0-9A-Za-z]{26}$/;
/** Never assigned to a route, so its tunnel is always refused: blocked, never direct. */
export const unassignedRoute = "rt_unassignedroutependingjoin";
const stateKey = "route-assignments-v1";
const entryPrefix = "route-assignment:";
const poolPrefix = "route-pool:";
const hintPrefix = "route-hint:";
const signInPrefix = "route-sign-in:";
const refusedPrefix = "route-refused:";
// A credential the pool holds on the refusing route: nothing has placed it on a route or direct yet.
const heldPrefix = "route-held:";
// When and why a hold began and how often it was decided again: the hold's two log lines read it.
const holdLogPrefix = "route-hold-log:";
/** Why the pool holds a credential; the only detail its hold and release lines carry. */
type HoldReason =
  | "rules_unserved"
  | "unclaimed"
  | "routes_disagree"
  | "resolve_failed"
  | "late_turn";
const HoldLog = Schema.Struct({
  reason: Schema.String,
  since: Schema.Number,
  repeats: Schema.Number,
});
// Rules change rarely; the revision poll catches edits, the floor catches anything it missed.
const refreshFloorMs = 15 * 60_000;
/**
 * How often the alarm asks the tools service. While rules are not served (a 404, or no 200 yet)
 * it asks again only after `unservedPauseMs`; a mirror or a new member still asks at once.
 * Served, its cheap revision poll runs at most every `servedPollMs`.
 */
export const unservedPauseMs = 10 * 60_000;
export const servedPollMs = 60_000;
/** Backends whose credentials a plugin the pool image ships serves (containers/pool/Dockerfile). */
export const imageProviderPlugins: ReadonlySet<string> = new Set(["gemini-cli", "typesafe"]);
/**
 * Plugin backends proven to send a routed credential's traffic only through its route. TypeSafe's
 * model calls run in the node's native executor, which uses the credential's proxy (route rig), and
 * its plugin's discovery never dials for a routed credential (change 45).
 */
export const routedPluginProviders: ReadonlySet<string> = new Set(["typesafe"]);
/**
 * The rest: their plugins make their own calls without the credential's proxy, so a routed owner's
 * credential here is refused. Home keeps it disabled, never used or refreshed (changes 37/39).
 */
export const pluginProviders: ReadonlySet<string> = new Set(
  [...imageProviderPlugins].filter((name) => !routedPluginProviders.has(name)),
);

const State = Schema.Struct({
  served: Schema.Boolean,
  // The pools this controller has prepared, so the alarm reads them by key, never by scan.
  pools: Schema.Array(Schema.String),
  // When the alarm last asked the tools service.
  polledAt: Schema.optional(Schema.Number),
});
type State = typeof State.Type;
const Entry = Schema.Struct({ routeId: Schema.String, owner: Schema.String });
type Entry = typeof Entry.Type;
const PoolRecord = Schema.Struct({
  organization: Schema.String,
  revision: Schema.Number,
  refreshedAt: Schema.Number,
  references: Schema.Array(Schema.String),
});
type PoolRecord = typeof PoolRecord.Type;
/** What a pass decides for one credential: a route, direct, a hold, or keep what it has. */
type Decision = Entry | null | "hold" | "keep";

/** A sign-in start's routing from the host: its route, direct, or refused (change 28/29). */
export function signInRoute(value: {
  hasRules?: unknown;
  route?: unknown;
}): Entry | null | "refuse" {
  const route = value.route;
  if (
    route &&
    typeof route === "object" &&
    "routeId" in route &&
    "owner" in route &&
    typeof route.routeId === "string" &&
    typeof route.owner === "string" &&
    valid({ routeId: route.routeId, owner: route.owner })
  )
    return { routeId: route.routeId, owner: route.owner };
  // A route that is present but unusable is never treated as direct.
  if (route !== undefined && route !== null) return "refuse";
  return value.hasRules === true && route !== null ? "refuse" : null;
}

export function routeProxyUrl(route: string) {
  if (!routeId.test(route)) return unavailable();
  return `socks5://${route}:x@${routePeerAddress}`;
}

/**
 * The pool writes only per-credential settings and never the node's global proxy: Home creates
 * acquired credentials without the pool, and an empty setting would inherit the global.
 */
export function credentialProxy(route: string | null, current = "") {
  if (route) return routeProxyUrl(route);
  // A proxy the host itself configured is not ours to clear.
  return current.includes(routePeerAddress) ? "" : current;
}

const valid = (value: RouteResolution | Entry | undefined): value is Entry =>
  Boolean(
    value?.routeId &&
    value.owner &&
    routeId.test(value.routeId) &&
    value.routeId !== unassignedRoute,
  );
/** A route that names something we can't route through is a failure, never direct. */
const malformed = (value: RouteResolution | undefined) =>
  value !== undefined && value.routeId !== null && !valid(value);

/**
 * One credential's answers from every pool it serves. A route beats direct; two different routes
 * can't both apply, so the credential is held until the rules agree.
 */
function combine(answers: readonly (RouteResolution | Entry | undefined)[]): Entry | null | "hold" {
  const routed = answers.filter(valid);
  if (!routed.length) return null;
  return routed.every(
    (entry) => entry.routeId === routed[0]!.routeId && entry.owner === routed[0]!.owner,
  )
    ? { routeId: routed[0]!.routeId, owner: routed[0]!.owner }
    : "hold";
}

type Credential =
  | { kind: "config"; family: string; proxy: string }
  | { kind: "auth"; proxy: string; provider: string; disabled: boolean };

async function writeAuth(home: HomeClient, id: string, proxy: string, signal: AbortSignal) {
  const result = await home.data("/credentials/fields", {
    ...post({ id, proxy_url: proxy }),
    method: "PATCH",
    signal,
  });
  if (result.status !== "ok") return unavailable();
}

async function writeDisabled(home: HomeClient, id: string, disabled: boolean, signal: AbortSignal) {
  const result = await home.data("/credentials/status", {
    ...post({ name: id, disabled }),
    method: "PATCH",
    signal,
  });
  if (result.status !== "ok" || result.disabled !== disabled) return unavailable();
}

async function readCredentials(home: HomeClient, signal: AbortSignal) {
  const credentials = new Map<string, Credential>();
  for (const [reference, value] of await readHomeConfigProxies(home, signal))
    credentials.set(reference, { kind: "config", ...value });
  for (const file of rows((await home.data("/credentials", { signal })).files)) {
    if (typeof file.id !== "string" || credentials.has(file.id)) continue;
    const proxy: unknown = file.proxy_url ?? file["proxy-url"];
    const provider: unknown = file.provider ?? file.type;
    credentials.set(file.id, {
      kind: "auth",
      proxy: typeof proxy === "string" ? proxy : "",
      provider: typeof provider === "string" ? provider : "",
      disabled: file.disabled === true,
    });
  }
  return credentials;
}

/** A stored record that doesn't decode fails the pass, as an unavailable store would. */
function decodeStored<T>(schema: Schema.Codec<T>, raw: unknown): T {
  const value = Schema.decodeUnknownOption(schema)(raw);
  return Option.isSome(value) ? value.value : unavailable();
}

const emptyAnswer: RouteAnswer = { served: true, revision: 0, resolutions: new Map() };
// A resolve answers in well under a second; it never holds a membership step for long.
export const resolveMs = 5_000;
export const writeMs = 30_000;
export const within = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/**
 * Which route each credential in this Home leaves through, and whose route it is. Any failed read,
 * resolve or write leaves the last values: a routed credential stays routed until a rule says
 * otherwise, and a credential with no answer yet cannot join a pool.
 */
export class RouteAssignments {
  private owners?: Map<string, string>;
  // Every pass that decides routes and writes them runs alone, so a pass that read older rules
  // can't lift what a newer one refused, and a mirror can't overwrite a pass in flight.
  private queue: Promise<unknown> = Promise.resolve();
  private queueWaitMs: number;
  // A late step's holds in flight: a membership turn decides only after them, so it can never lift
  // a hold, or a plugin credential's refusal, that a late hold is still writing.
  private holding: Promise<unknown> = Promise.resolve();
  // The alarm's failing passes in a row: one line when they start and one when they end. In
  // memory: a restarted controller starts a new streak.
  private failing?: { since: number; failures: number };
  // Per pool, how many membership steps have started: a late turn behind a newer step steps aside.
  private steps = new Map<string, number>();
  private storage: RouteStorage;
  private resolver: RouteResolver;
  private home: HomeClient;
  private now: () => number;
  constructor(
    storage: RouteStorage,
    resolver: RouteResolver,
    home: HomeClient,
    now: () => number = Date.now,
    queueWaitMs = 2_000,
  ) {
    this.storage = storage;
    this.resolver = resolver;
    this.home = home;
    this.now = now;
    this.queueWaitMs = queueWaitMs;
  }

  private async state(): Promise<State> {
    const raw = await this.storage.get(stateKey);
    return raw === undefined ? { served: false, pools: [] } : decodeStored(State, raw);
  }
  private async listed<T>(prefix: string, schema: Schema.Codec<T>) {
    return new Map(
      [...(await this.storage.list({ prefix }))].map(([key, value]) => [
        key.slice(prefix.length),
        decodeStored(schema, value),
      ]),
    );
  }
  private entries() {
    return this.listed(entryPrefix, Entry);
  }
  private async pools() {
    const pools = new Map<string, PoolRecord>();
    for (const pool of (await this.state()).pools) {
      const raw = await this.storage.get(poolPrefix + pool);
      if (raw !== undefined) pools.set(pool, decodeStored(PoolRecord, raw));
    }
    return pools;
  }

  /**
   * Until the first 200, any failure (404, unreachable, 5xx, 401) means no rules are served, so
   * everything stays direct as before. After it, a failure keeps the last values.
   */
  private async ask(
    scope: RouteScope,
    references: readonly string[],
    signal: AbortSignal,
  ): Promise<RouteAnswer> {
    let answer: RouteAnswer;
    try {
      answer = await this.resolver.resolve(scope, references, signal);
    } catch (error) {
      if ((await this.state()).served) throw error;
      answer = { served: false, revision: 0, resolutions: new Map() };
    }
    const state = await this.state();
    if (!answer.served) {
      if (state.served) return unavailable();
      return {
        served: false,
        revision: 0,
        resolutions: new Map(
          references.map((reference) => [reference, { routeId: null, owner: null }]),
        ),
      };
    }
    // Any 200 means rules are served, from then on durably; only then is its content judged.
    // The first 200 also ends the unserved pause, so the alarm reads the new rules at once.
    if (!state.served)
      await this.storage.put(stateKey, {
        served: true,
        pools: state.pools,
      } satisfies State);
    // An answer missing a requested reference, or naming a route we can't use, is a failure.
    if (
      references.some(
        (reference) =>
          !answer.resolutions.has(reference) || malformed(answer.resolutions.get(reference)),
      )
    )
      return unavailable();
    return answer;
  }

  /** Whether the pool disabled this credential because its plugin can't use the route. */
  async refused(reference: string) {
    return (await this.storage.get(refusedPrefix + reference)) === true;
  }
  /**
   * Whether `provider`'s credential must stay off: a route applies, which its plugin can't use, or
   * the pool holds it, or the pool's own refusal hasn't been lifted yet. An owner's pause clears
   * only the last; a hint alone never refuses, so a credential its rules made direct can resume.
   */
  async refusesUse(reference: string, provider: string) {
    if (!pluginProviders.has(provider)) return false;
    return (
      (await this.storage.get(entryPrefix + reference)) !== undefined ||
      (await this.held(reference)) ||
      (await this.refused(reference))
    );
  }
  private async held(reference: string) {
    return (await this.storage.get(heldPrefix + reference)) === true;
  }
  /**
   * Holds `reference` for `reason`, or releases it with `false`. A hold logs once when it begins
   * and once when it ends, with how long it lasted and how often a pass decided it again, so a
   * long outage adds one counter per held credential and no lines.
   */
  private async hold(reference: string, reason: HoldReason | false) {
    const held = await this.held(reference);
    // Only a recorded hold is deleted, so a pool without rules writes nothing here.
    if (reason === false && !held) return;
    // A log record that doesn't decode only loses its numbers; it never keeps a hold in place.
    const log = Option.getOrUndefined(
      Schema.decodeUnknownOption(HoldLog)(await this.storage.get(holdLogPrefix + reference)),
    );
    if (reason !== false) {
      if (!held) {
        await this.storage.put(heldPrefix + reference, true);
        await this.storage.put(holdLogPrefix + reference, {
          reason,
          since: this.now(),
          repeats: 0,
        });
        console.error("POOL_ROUTE_MEMBER_HELD", JSON.stringify({ reason }));
      } else
        await this.storage.put(holdLogPrefix + reference, {
          reason: log?.reason ?? reason,
          since: log?.since ?? this.now(),
          repeats: (log?.repeats ?? 0) + 1,
        });
      return;
    }
    await this.storage.delete(heldPrefix + reference);
    await this.storage.delete(holdLogPrefix + reference);
    console.error(
      "POOL_ROUTE_MEMBER_RELEASED",
      JSON.stringify(
        log
          ? { reason: log.reason, heldMs: this.now() - log.since, repeats: log.repeats }
          : { reason: "unrecorded" },
      ),
    );
  }
  async refusedReferences(): Promise<ReadonlySet<string>> {
    return new Set((await this.listed(refusedPrefix, Schema.Literal(true))).keys());
  }
  /** The mirror saved this credential disabled for its route, or Home's own state now holds. */
  async markRefused(reference: string, refused: boolean) {
    if (refused) await this.storage.put(refusedPrefix + reference, true);
    else await this.storage.delete(refusedPrefix + reference);
  }

  /** Whether the host said this credential's owner has a rule that could route it. */
  private async hasRules(reference: string) {
    return (await this.storage.get(hintPrefix + reference)) === true;
  }

  /** The person whose route this pool assigned, or null: PoolRoutePeer refuses anything else. */
  async routeOwner(route: string): Promise<string | null> {
    if (!this.owners) {
      const owners = new Map<string, string>();
      const conflicting = new Set<string>();
      const signIns = await this.listed(signInPrefix, Entry);
      for (const entry of [...(await this.entries()).values(), ...signIns.values()]) {
        const known = owners.get(entry.routeId);
        if (known !== undefined && known !== entry.owner) conflicting.add(entry.routeId);
        owners.set(entry.routeId, entry.owner);
      }
      for (const id of conflicting) owners.delete(id);
      this.owners = owners;
    }
    return this.owners.get(route) ?? null;
  }

  private async record(reference: string, entry: Entry | null) {
    this.owners = undefined;
    if (entry) await this.storage.put(entryPrefix + reference, entry);
    else await this.storage.delete(entryPrefix + reference);
  }

  /**
   * Write `routes` into Home. Owners are recorded before Home names a route, and dropped only
   * after Home no longer does, so the tunnel's owner check never lags the credential. Each
   * credential is written on its own; one failed write doesn't stop the others, and the pass
   * fails afterwards so it runs again.
   */
  private async apply(
    routes: ReadonlyMap<string, Decision>,
    signal: AbortSignal,
    // Why each hold is held; combine's disagreement is the only hold a caller doesn't name.
    reasons: ReadonlyMap<string, HoldReason> = new Map(),
  ) {
    // Routes and holds are on record before Home is read: the owner is known before Home names a
    // route, a credential Home doesn't hold yet keeps its hold, and a resume racing this pass sees
    // what it decided.
    for (const [reference, decision] of routes)
      if (decision === "hold")
        await this.hold(reference, reasons.get(reference) ?? "routes_disagree");
      else if (decision !== "keep" && decision !== null) await this.record(reference, decision);
    const credentials = await readCredentials(this.home, signal);
    let failed = false;
    for (const [reference, decision] of routes) {
      if (decision === "keep") continue;
      const credential = credentials.get(reference);
      if (!credential) {
        if (decision === null) {
          await this.record(reference, null);
          await this.hold(reference, false);
        }
        continue;
      }
      const plugin = credential.kind === "auth" && pluginProviders.has(credential.provider);
      // Disabled before its proxy changes, so a refused plugin credential is never live routed.
      // The marker comes first: one without the write only means a harmless lift later.
      if (plugin && decision !== null && !credential.disabled)
        try {
          await this.storage.put(refusedPrefix + reference, true);
          await writeDisabled(this.home, reference, true, signal);
        } catch {
          failed = true;
          continue;
        }
      // A hold never replaces a route another pool already gave the credential.
      if (decision === "hold" && credential.proxy.includes(routePeerAddress)) continue;
      const proxy =
        decision === "hold"
          ? routeProxyUrl(unassignedRoute)
          : credentialProxy(decision?.routeId ?? null, credential.proxy);
      try {
        if (proxy !== credential.proxy) {
          if (credential.kind === "config")
            await setHomeConfigProxy(this.home, credential.family, reference, proxy, signal);
          else await writeAuth(this.home, reference, proxy, signal);
        }
        // Only the pool's own refusal is lifted; an owner's pause stays.
        if (plugin && decision === null && (await this.refused(reference))) {
          await writeDisabled(this.home, reference, false, signal);
          await this.storage.delete(refusedPrefix + reference);
        }
        if (decision === null) await this.record(reference, null);
        if (decision !== "hold") await this.hold(reference, false);
      } catch {
        failed = true;
      }
    }
    if (failed) return unavailable();
  }

  /** Runs `work` after every pass before it; a mirror wraps its decision and its save in one. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Called before a pool's membership is reconciled, so its new members are routed before Home
   * lets them serve. It never fails the membership step on a resolve: after rules were served, a
   * new member nothing placed is held on the refusing route (only a stored route or a
   * hasRules:false hint decides it without an answer), and the next pass resolves it again. It
   * reads storage by key and touches Home only when a route, a hold or a hold to clear is at stake.
   *
   * It decides in the queue like every other pass, but the repair it sits on (and the lease
   * renewals behind that repair) waits for its turn at most `queueWaitMs`. A turn that hasn't
   * started by then still runs when the queue drains, adding the members it decides to the pool
   * record and removing none. Until then a new member nothing placed is held, which costs the
   * repair one Home read and its writes (bounded by `writeMs`; a failed write fails the repair,
   * so nothing serves unplaced). A step with no new member never queues.
   */
  async prepare(scope: RouteScope, accounts: readonly string[], signal?: AbortSignal) {
    const step = (this.steps.get(scope.pool) ?? 0) + 1;
    this.steps.set(scope.pool, step);
    const raw = await this.storage.get(poolPrefix + scope.pool);
    const known = raw === undefined ? undefined : decodeStored(PoolRecord, raw).references;
    if (known && accounts.every((account) => known.includes(account)))
      return this.preparePass(scope, accounts, signal);
    let started = false;
    let late = false;
    const turn = this.serial(async () => {
      // A newer step for this pool saw a newer membership; it decides its own new members.
      if (late && this.steps.get(scope.pool) !== step) return;
      // Started before it waits, so its step never turns late (and holds) behind it.
      started = true;
      // Every late hold, including any that starts while this one waits, lands before it decides.
      for (let seen: Promise<unknown> | undefined; seen !== this.holding;) {
        seen = this.holding;
        await seen.catch(() => {});
      }
      await this.preparePass(scope, accounts, signal, late);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.queueWaitMs);
    });
    try {
      if ((await Promise.race([turn, waited])) !== "late" || started) return await turn;
      late = true;
      void turn.catch((error: unknown) =>
        console.error("POOL_ROUTE_MEMBERSHIP_LATE_TURN_FAILED", String(error)),
      );
      // Home serves the new members as soon as this step returns: until the turn decides them,
      // one nothing has placed waits on the refusing route instead of serving direct.
      const holds = this.holdUnplaced(scope, accounts, signal);
      this.holding = Promise.all([this.holding.catch(() => {}), holds]);
      await holds;
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * A late step's new members that nothing placed: no `hasRules:false` hint, no route on record,
   * no hold. Only after rules were served; before that nothing is routed. It runs outside the
   * queue, but every membership turn waits for it, so only a mirror can race it, and it writes
   * nothing but the refusing route, never over a route already in Home. The worst such a race can
   * leave is a credential refused until its turn routes it (or, if that resolve fails too, until
   * the next refresh), never one sent direct.
   */
  private async holdUnplaced(scope: RouteScope, accounts: readonly string[], signal?: AbortSignal) {
    if (!(await this.state()).served) return;
    const raw = await this.storage.get(poolPrefix + scope.pool);
    const known = new Set(raw === undefined ? [] : decodeStored(PoolRecord, raw).references);
    const holds = new Map<string, Decision>();
    for (const reference of new Set(accounts))
      if (
        !known.has(reference) &&
        (await this.storage.get(hintPrefix + reference)) !== false &&
        (await this.storage.get(entryPrefix + reference)) === undefined &&
        !(await this.held(reference))
      )
        holds.set(reference, "hold");
    if (holds.size)
      await this.apply(
        holds,
        within(writeMs, signal),
        new Map([...holds.keys()].map((reference) => [reference, "late_turn"])),
      );
  }
  private async preparePass(
    scope: RouteScope,
    accounts: readonly string[],
    signal?: AbortSignal,
    // A turn that ran after its repair moved on: it adds what it decided and removes nothing.
    additive = false,
  ) {
    const raw = await this.storage.get(poolPrefix + scope.pool);
    const record = raw === undefined ? undefined : decodeStored(PoolRecord, raw);
    const known = new Set(record?.references ?? []);
    const members = [...new Set(accounts)];
    const added = members.filter((account) => !known.has(account));
    let unresolved: string[] = [];
    if (added.length) {
      // A member whose host said its owner has no rules is direct without asking.
      const ruleless = new Set<string>();
      for (const reference of added)
        if ((await this.storage.get(hintPrefix + reference)) === false) ruleless.add(reference);
      const asked = added.filter((reference) => !ruleless.has(reference));
      let answer: RouteAnswer | undefined = asked.length ? undefined : emptyAnswer;
      if (asked.length)
        try {
          answer = await this.ask(scope, asked, within(resolveMs, signal));
        } catch {
          unresolved = asked;
        }
      const atStake = new Map<string, Decision>();
      const reasons = new Map<string, HoldReason>();
      for (const reference of added) {
        const stored = await this.storage.get(entryPrefix + reference);
        const entry = stored === undefined ? undefined : decodeStored(Entry, stored);
        const rules = await this.hasRules(reference);
        const held = await this.held(reference);
        // Before any 200, the host's hasRules is the only proof of rules: never direct then. A
        // failed resolve can only come after one (`ask`), so a member it leaves unplaced is held:
        // only a stored route keeps what Home has, and only a hasRules:false hint serves direct.
        const decision: Decision = ruleless.has(reference)
          ? null
          : answer
            ? !answer.served && rules
              ? "hold"
              : combine([answer.resolutions.get(reference), entry])
            : entry
              ? "keep"
              : "hold";
        if (decision === "hold")
          reasons.set(
            reference,
            !answer ? "resolve_failed" : !answer.served ? "rules_unserved" : "routes_disagree",
          );
        // A held member is always at stake, so the first answer that places it releases it.
        if (decision !== "keep" && (decision !== null || entry || rules || held))
          atStake.set(reference, decision);
      }
      if (atStake.size) await this.apply(atStake, within(writeMs, signal), reasons);
    }
    // Every step re-adds a pool the list lost, so a pool is never dropped from the alarm for good.
    const state = await this.state();
    if (!state.pools.includes(scope.pool))
      await this.storage.put(stateKey, {
        ...state,
        pools: [...state.pools, scope.pool],
      } satisfies State);
    await this.storage.put(poolPrefix + scope.pool, {
      organization: scope.organization,
      revision: record?.revision ?? -1,
      refreshedAt: record?.refreshedAt ?? 0,
      // Unresolved members stay new, so the next membership pass asks for them again.
      references: [
        ...new Set([
          ...(additive ? known : []),
          ...members.filter((member) => !unresolved.includes(member)),
        ]),
      ],
    } satisfies PoolRecord);
  }

  /**
   * The setting a credential is written with when the host mirrors it, or undefined to keep the
   * host's own. Home refreshes a credential as soon as it holds it, before any membership step.
   * - The host's pool-free route is written at once; a malformed one answers 503.
   * - An owner with rules: every pool here is asked; if none claims it yet, or the pools
   *   disagree, it waits on the refusing route, and a failed resolve answers 503.
   * - Anyone else is mirrored exactly as before with no resolve call; without a hint a route its
   *   membership step already assigned is kept. Once rules are served, a mirror without a hint
   *   is decided like an owner with rules: Home refreshes what it holds before any membership
   *   step could route it, so nothing unplaced is written direct then.
   */
  async proxyFor(
    reference: string,
    hint: MirrorRouteHint,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (hint.hasRules !== undefined) await this.storage.put(hintPrefix + reference, hint.hasRules);
    if (hint.route !== undefined) {
      const route = hint.route;
      if (route !== null && !valid(route)) return unavailable();
      const entry = route && valid(route) ? { routeId: route.routeId, owner: route.owner } : null;
      await this.record(reference, entry);
      await this.hold(reference, false);
      return entry ? routeProxyUrl(entry.routeId) : undefined;
    }
    if (hint.hasRules === false) {
      await this.record(reference, null);
      await this.hold(reference, false);
      return undefined;
    }
    if (hint.hasRules === undefined) {
      // A re-mirror never drops a credential its membership step routed.
      const stored = await this.storage.get(entryPrefix + reference);
      const kept = stored === undefined ? undefined : decodeStored(Entry, stored);
      if (kept) return routeProxyUrl(kept.routeId);
      // Nor a hold.
      if (await this.held(reference)) return routeProxyUrl(unassignedRoute);
      // Before any 200 nothing is routed, and a host that said its owner has no rules is believed:
      // both stay exactly as on main.
      if (
        !(await this.state()).served ||
        (await this.storage.get(hintPrefix + reference)) === false
      )
        return undefined;
      // A pool member a pass already placed direct stays so: a token rotation never waits on, or
      // fails with, the tools service.
      for (const record of (await this.pools()).values())
        if (record.references.includes(reference)) return undefined;
    }
    const answers: (RouteResolution | undefined)[] = [];
    let claimed = false;
    for (const [pool, record] of await this.pools()) {
      const answer = (
        await this.ask({ pool, organization: record.organization }, [reference], signal)
      ).resolutions.get(reference);
      // An owner means the tools service knows this reference as a member of that pool.
      if (!answer?.owner && !record.references.includes(reference)) continue;
      claimed = true;
      answers.push(answer);
    }
    const decision = combine(answers);
    const served = (await this.state()).served;
    // Before any 200 a hasRules:true credential is held too: a 200 decides it, never a 404.
    if (decision === "hold" || !claimed || !served) {
      await this.hold(
        reference,
        decision === "hold" ? "routes_disagree" : !served ? "rules_unserved" : "unclaimed",
      );
      return routeProxyUrl(unassignedRoute);
    }
    await this.record(reference, decision);
    await this.hold(reference, false);
    return decision ? routeProxyUrl(decision.routeId) : undefined;
  }

  /** `owner`'s first routed credential among `accounts`, in the caller's display order. */
  async ownRoute(owner: string, accounts: readonly string[]): Promise<string | null> {
    const entries = await this.entries();
    for (const account of accounts) {
      const entry = entries.get(account);
      if (entry?.owner === owner) return entry.routeId;
    }
    return null;
  }

  /**
   * A routed sign-in's own owner check: Home's code exchange tunnels through the route before any
   * credential exists. Settling it gives each saved credential the same route and owner.
   */
  async beginSignIn(session: string, route: Entry) {
    this.owners = undefined;
    await this.storage.put(signInPrefix + session, route);
  }
  settleSignIn(session: string, references: readonly string[]) {
    return this.serial(() => this.settlePass(session, references));
  }
  private async settlePass(session: string, references: readonly string[]) {
    const raw = await this.storage.get(signInPrefix + session);
    if (raw === undefined) return;
    const route = decodeStored(Entry, raw);
    // Home saves the route on what it creates; this re-asserts it, so no later call goes direct.
    if (references.length)
      await this.apply(new Map(references.map((reference) => [reference, route])), within(writeMs));
    this.owners = undefined;
    await this.storage.delete(signInPrefix + session);
  }

  /** A removed credential no longer vouches for its route. */
  async forget(reference: string) {
    await this.storage.delete(hintPrefix + reference);
    await this.storage.delete(refusedPrefix + reference);
    await this.hold(reference, false);
    await this.record(reference, null);
  }

  /** On the pool's alarm: one cheap poll per pool, a full pass when a revision or the floor says so. */
  async tick(signal: AbortSignal) {
    try {
      const asked = await this.serial(() => this.tickPass(signal));
      if (asked && this.failing) {
        console.error(
          "POOL_ROUTE_ASSIGNMENTS_RECOVERED",
          JSON.stringify({
            failures: this.failing.failures,
            pendingMs: this.now() - this.failing.since,
          }),
        );
        this.failing = undefined;
      }
    } catch (error) {
      if (this.failing) this.failing.failures++;
      else {
        this.failing = { since: this.now(), failures: 1 };
        console.error("POOL_ROUTE_ASSIGNMENTS_PENDING");
      }
      throw error;
    }
  }
  /** Whether it asked the tools service; between polls it doesn't. */
  private async tickPass(signal: AbortSignal): Promise<boolean> {
    const state = await this.state();
    if (
      this.now() - (state.polledAt ?? -Infinity) <
      (state.served ? servedPollMs : unservedPauseMs)
    )
      return false;
    await this.storage.put(stateKey, { ...state, polledAt: this.now() } satisfies State);
    const pools = await this.pools();
    let due = false;
    for (const [pool, record] of pools) {
      const poll = await this.ask(
        { pool, organization: record.organization },
        [],
        within(resolveMs, signal),
      );
      // While no rules are served nothing can be routed, so there is nothing to rewrite.
      if (!poll.served) return true;
      if (poll.revision !== record.revision || this.now() - record.refreshedAt >= refreshFloorMs)
        due = true;
    }
    if (due) await this.refreshPass(signal);
    return true;
  }

  refresh(signal: AbortSignal) {
    return this.serial(() => this.refreshPass(signal));
  }
  private async refreshPass(signal: AbortSignal) {
    const pools = await this.pools();
    const answers = new Map<string, RouteResolution[]>();
    const revisions = new Map<string, number>();
    for (const [pool, record] of pools) {
      const answer = await this.ask(
        { pool, organization: record.organization },
        record.references,
        within(resolveMs, signal),
      );
      revisions.set(pool, answer.revision);
      for (const reference of record.references)
        answers.set(reference, [
          ...(answers.get(reference) ?? []),
          answer.resolutions.get(reference)!,
        ]);
    }
    const credentials = await readCredentials(this.home, within(writeMs, signal));
    const entries = await this.entries();
    const routes = new Map<string, Decision>();
    // A credential no pool claims keeps what it has; one Home no longer holds drops its owner.
    for (const reference of new Set([...credentials.keys(), ...entries.keys()]))
      routes.set(
        reference,
        !credentials.has(reference)
          ? null
          : answers.has(reference)
            ? combine(answers.get(reference)!)
            : "keep",
      );
    await this.apply(routes, within(writeMs, signal));
    const at = this.now();
    // Re-read: a membership step may have changed a record meanwhile. In a Durable Object this
    // read and write run under one input gate, so nothing lands between them.
    for (const pool of pools.keys()) {
      const raw = await this.storage.get(poolPrefix + pool);
      if (raw === undefined) continue;
      await this.storage.put(poolPrefix + pool, {
        ...decodeStored(PoolRecord, raw),
        revision: revisions.get(pool)!,
        refreshedAt: at,
      } satisfies PoolRecord);
    }
  }
}
