import { Schema } from "effect";
import { readHomeConfigProxies, setHomeConfigProxy } from "./account-config-mirror.ts";
import type { HomeClient } from "./control.ts";
import { object, post, rows, unavailable } from "./json.ts";
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
// Rules change rarely; the revision poll catches edits, the floor catches anything it missed.
const refreshFloorMs = 15 * 60_000;

const State = Schema.Struct({
  served: Schema.Boolean,
  global: Schema.String,
  // The pools this controller has prepared, so the alarm reads them by key, never by scan.
  pools: Schema.Array(Schema.String),
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

export function routeProxyUrl(route: string) {
  if (!routeId.test(route)) return unavailable();
  return `socks5://${route}:x@${routePeerAddress}`;
}

const direct = (proxy: string) => proxy === "" || proxy.toLowerCase() === "direct";

/**
 * An empty credential setting inherits the node's global proxy. While the global names a route,
 * an unrouted credential must say "direct", or it would leave through someone else's route.
 */
export function credentialProxy(route: string | null, globalRouted: boolean, current = "") {
  if (route) return routeProxyUrl(route);
  // A proxy the host itself configured is not ours to clear.
  if (!direct(current) && !current.includes(routePeerAddress)) return current;
  if (globalRouted) return "direct";
  return direct(current) ? current : "";
}

/** The node's own calls (version checks, plugin store) follow a route only when every credential does. */
export function globalProxy(routes: readonly (string | null)[]) {
  const first = routes[0];
  return first && routes.every((route) => route === first) ? routeProxyUrl(first) : "";
}

const valid = (value: RouteResolution | Entry | undefined): value is Entry =>
  Boolean(
    value?.routeId &&
    value.owner &&
    routeId.test(value.routeId) &&
    value.routeId !== unassignedRoute,
  );

/**
 * One credential's answers from every pool it serves. A route beats direct; two different routes
 * are a conflict, and a conflict keeps whatever the credential has now.
 */
function combine(
  answers: readonly (RouteResolution | Entry | undefined)[],
): Entry | null | "conflict" {
  const routed = answers.filter(valid);
  if (!routed.length) return null;
  return routed.every(
    (entry) => entry.routeId === routed[0]!.routeId && entry.owner === routed[0]!.owner,
  )
    ? { routeId: routed[0]!.routeId, owner: routed[0]!.owner }
    : "conflict";
}

type Credential =
  | { kind: "config"; family: string; proxy: string }
  | { kind: "auth"; proxy: string };

async function readGlobal(home: HomeClient, signal: AbortSignal) {
  const requests = (await home.data("/config", { signal })).requests;
  const value = object(requests) ? requests["proxy-url"] : undefined;
  return typeof value === "string" ? value : "";
}

async function writeGlobal(home: HomeClient, proxy: string, signal: AbortSignal) {
  // PATCH changes only this field; the supervisor's boot patch never names it.
  await home.data("/config", {
    ...post({ requests: { "proxy-url": proxy } }),
    method: "PATCH",
    signal,
  });
  if ((await readGlobal(home, signal)) !== proxy) return unavailable();
}

async function writeAuth(home: HomeClient, id: string, proxy: string, signal: AbortSignal) {
  const result = await home.data("/credentials/fields", {
    ...post({ id, proxy_url: proxy }),
    method: "PATCH",
    signal,
  });
  if (result.status !== "ok") return unavailable();
}

async function readCredentials(home: HomeClient, signal: AbortSignal) {
  const credentials = new Map<string, Credential>();
  for (const [reference, value] of await readHomeConfigProxies(home, signal))
    credentials.set(reference, { kind: "config", ...value });
  for (const file of rows((await home.data("/credentials", { signal })).files)) {
    if (typeof file.id !== "string" || credentials.has(file.id)) continue;
    const proxy: unknown = file.proxy_url ?? file["proxy-url"];
    credentials.set(file.id, { kind: "auth", proxy: typeof proxy === "string" ? proxy : "" });
  }
  return credentials;
}

/**
 * Which route each credential in this Home leaves through, and whose route it is. Any failed read,
 * resolve or write leaves the last values: a routed credential stays routed until a rule says
 * otherwise, and a credential with no answer yet cannot join a pool.
 */
export class RouteAssignments {
  private owners?: Map<string, string>;
  private storage: RouteStorage;
  private resolver: RouteResolver;
  private home: HomeClient;
  private now: () => number;
  constructor(
    storage: RouteStorage,
    resolver: RouteResolver,
    home: HomeClient,
    now: () => number = Date.now,
  ) {
    this.storage = storage;
    this.resolver = resolver;
    this.home = home;
    this.now = now;
  }

  private async state(): Promise<State> {
    const raw = await this.storage.get(stateKey);
    return raw === undefined
      ? { served: false, global: "", pools: [] }
      : Schema.decodeUnknownSync(State)(raw);
  }
  private async listed<T>(prefix: string, schema: Schema.Codec<T>) {
    return new Map(
      [...(await this.storage.list({ prefix }))].map(([key, value]) => [
        key.slice(prefix.length),
        Schema.decodeUnknownSync(schema)(value),
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
      if (raw !== undefined) pools.set(pool, Schema.decodeUnknownSync(PoolRecord)(raw));
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
    // An answer missing a requested reference is a failure like any other.
    if (answer.served && references.some((reference) => !answer.resolutions.has(reference)))
      answer = { served: false, revision: 0, resolutions: new Map() };
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
    if (!state.served) await this.storage.put(stateKey, { ...state, served: true } satisfies State);
    return answer;
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
      for (const entry of (await this.entries()).values()) {
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
   * after Home no longer does, so the tunnel's owner check never lags the credential.
   */
  private async apply(
    routes: ReadonlyMap<string, Entry | null | "conflict" | "pending">,
    global: string | undefined,
    signal: AbortSignal,
  ) {
    const credentials = await readCredentials(this.home, signal);
    const state = await this.state();
    const globalRouted = (global ?? state.global) !== "";
    const cleared: string[] = [];
    for (const [reference, entry] of routes) {
      if (entry === "conflict") continue;
      const credential = credentials.get(reference);
      if (entry === "pending") {
        // Held only until a resolve answers; a credential another pool already routes keeps it.
        if (!credential || credential.proxy.includes(routePeerAddress)) continue;
      } else if (entry) await this.record(reference, entry);
      else cleared.push(reference);
      if (!credential) continue;
      const proxy =
        entry === "pending"
          ? routeProxyUrl(unassignedRoute)
          : credentialProxy(entry?.routeId ?? null, globalRouted, credential.proxy);
      if (proxy === credential.proxy) continue;
      if (credential.kind === "config")
        await setHomeConfigProxy(this.home, credential.family, reference, proxy, signal);
      else await writeAuth(this.home, reference, proxy, signal);
    }
    if (global !== undefined && (await readGlobal(this.home, signal)) !== global)
      await writeGlobal(this.home, global, signal);
    for (const reference of cleared) await this.record(reference, null);
    if (global !== undefined)
      await this.storage.put(stateKey, { ...(await this.state()), global } satisfies State);
  }

  /**
   * Called before a pool's membership is reconciled or installed, so its new members are routed
   * before Home or a runtime may serve them. It never fails the membership step: when the resolve
   * fails, only new members whose owner has rules are held on the refusing route, everyone else
   * keeps serving as before, and the next pass resolves them again.
   */
  async prepare(scope: RouteScope, accounts: readonly string[], signal: AbortSignal) {
    // Point reads only: this runs before every policy install and never scans storage.
    const raw = await this.storage.get(poolPrefix + scope.pool);
    const record = raw === undefined ? undefined : Schema.decodeUnknownSync(PoolRecord)(raw);
    const known = new Set(record?.references ?? []);
    const members = [...new Set(accounts)];
    const added = members.filter((account) => !known.has(account));
    let unresolved: string[] = [];
    if (added.length) {
      let answer: RouteAnswer | undefined;
      try {
        answer = await this.ask(scope, added, signal);
      } catch {
        unresolved = added;
      }
      const entries = new Map<string, Entry>();
      for (const reference of added) {
        const stored = await this.storage.get(entryPrefix + reference);
        if (stored !== undefined) entries.set(reference, Schema.decodeUnknownSync(Entry)(stored));
      }
      const routes = new Map<string, Entry | null | "conflict" | "pending">();
      for (const reference of added) {
        if (answer)
          routes.set(
            reference,
            combine([answer.resolutions.get(reference), entries.get(reference)]),
          );
        else if (await this.hasRules(reference)) routes.set(reference, "pending");
      }
      // Home is read only when a route, a hold or a hold to clear is at stake. For everyone else
      // this step, which also runs before every native policy install, stays as cheap as on main.
      const atStake = new Map<string, Entry | null | "conflict" | "pending">();
      for (const [reference, entry] of routes)
        if (
          entry !== "conflict" &&
          (entry !== null || entries.has(reference) || (await this.hasRules(reference)))
        )
          atStake.set(reference, entry);
      if (atStake.size) await this.apply(atStake, undefined, signal);
    }
    if (!record) {
      const state = await this.state();
      if (!state.pools.includes(scope.pool))
        await this.storage.put(stateKey, {
          ...state,
          pools: [...state.pools, scope.pool],
        } satisfies State);
    }
    await this.storage.put(poolPrefix + scope.pool, {
      organization: scope.organization,
      revision: record?.revision ?? -1,
      refreshedAt: record?.refreshedAt ?? 0,
      // Unresolved members stay new, so the next membership pass asks for them again.
      references: members.filter((member) => !unresolved.includes(member)),
    } satisfies PoolRecord);
  }

  /**
   * The setting a credential is written with when the host mirrors it, or undefined to keep the
   * host's own. Home refreshes a credential as soon as it holds it, before any membership step.
   * - The host's pool-free route is written at once.
   * - An owner with rules: every pool here is asked; if none claims it yet, it waits on the
   *   refusing route until its membership step routes it, and a failed resolve answers 503.
   * - Anyone else, or a host that sends no hint, is mirrored exactly as before with no resolve
   *   call; without a hint a route its membership step already assigned is kept.
   */
  async proxyFor(
    reference: string,
    hint: MirrorRouteHint,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (hint.hasRules !== undefined) await this.storage.put(hintPrefix + reference, hint.hasRules);
    const state = await this.state();
    const direct = () => (state.global !== "" ? "direct" : undefined);
    if (hint.route !== undefined) {
      const route = hint.route ?? undefined;
      const entry = valid(route) ? { routeId: route.routeId, owner: route.owner } : null;
      await this.record(reference, entry);
      return entry ? routeProxyUrl(entry.routeId) : direct();
    }
    if (hint.hasRules === false) {
      await this.record(reference, null);
      return direct();
    }
    if (hint.hasRules === undefined) {
      // A re-mirror never drops a credential its membership step routed.
      const stored = await this.storage.get(entryPrefix + reference);
      const kept = stored === undefined ? undefined : Schema.decodeUnknownSync(Entry)(stored);
      return kept ? routeProxyUrl(kept.routeId) : direct();
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
    const entry = combine(answers);
    if (entry === "conflict") return unavailable();
    if (!claimed && (await this.state()).served) return routeProxyUrl(unassignedRoute);
    await this.record(reference, entry);
    return entry ? routeProxyUrl(entry.routeId) : direct();
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

  /** A removed credential no longer vouches for its route. */
  async forget(reference: string) {
    await this.storage.delete(hintPrefix + reference);
    await this.record(reference, null);
  }

  /** On the pool's alarm: one cheap poll per pool, a full pass when a revision or the floor says so. */
  async tick(signal: AbortSignal) {
    const pools = await this.pools();
    let due = false;
    for (const [pool, record] of pools) {
      const poll = await this.ask({ pool, organization: record.organization }, [], signal);
      // While no rules are served nothing can be routed, so there is nothing to rewrite.
      if (!poll.served) return;
      if (poll.revision !== record.revision || this.now() - record.refreshedAt >= refreshFloorMs)
        due = true;
    }
    if (due) await this.refresh(signal);
  }

  async refresh(signal: AbortSignal) {
    const pools = await this.pools();
    const answers = new Map<string, RouteResolution[]>();
    const revisions = new Map<string, number>();
    for (const [pool, record] of pools) {
      const answer = await this.ask(
        { pool, organization: record.organization },
        record.references,
        signal,
      );
      revisions.set(pool, answer.revision);
      for (const reference of record.references)
        answers.set(reference, [
          ...(answers.get(reference) ?? []),
          answer.resolutions.get(reference)!,
        ]);
    }
    const credentials = await readCredentials(this.home, signal);
    const entries = await this.entries();
    const routes = new Map<string, Entry | null | "conflict">();
    // A credential no pool claims keeps what it has; one Home no longer holds drops its owner.
    for (const reference of new Set([...credentials.keys(), ...entries.keys()]))
      routes.set(
        reference,
        !credentials.has(reference)
          ? null
          : answers.has(reference)
            ? combine(answers.get(reference)!)
            : "conflict",
      );
    // A conflicted credential keeps its current route, so it counts as that route for the global.
    const effective = [...credentials.keys()].map((reference) => {
      const entry = routes.get(reference);
      return entry === "conflict"
        ? (entries.get(reference)?.routeId ?? null)
        : (entry?.routeId ?? null);
    });
    await this.apply(routes, globalProxy(effective), signal);
    const at = this.now();
    for (const [pool, record] of pools)
      await this.storage.put(poolPrefix + pool, {
        ...record,
        revision: revisions.get(pool)!,
        refreshedAt: at,
      } satisfies PoolRecord);
  }
}
