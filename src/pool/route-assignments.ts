import { Schema } from "effect";
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
// Rules change rarely; the revision poll catches edits, the floor catches anything it missed.
const refreshFloorMs = 15 * 60_000;
/**
 * How often the alarm asks the tools service. While rules are not served (a 404, or no 200 yet)
 * it asks again only after `unservedPauseMs`; a mirror or a new member still asks at once.
 * Served, its cheap revision poll runs at most every `servedPollMs`.
 */
export const unservedPauseMs = 10 * 60_000;
export const servedPollMs = 60_000;
/**
 * Backends whose model calls and refreshes a Home plugin makes. No rig case yet proves a plugin
 * sends through the credential's proxy, so a routed owner's credential here is refused: Home keeps
 * it disabled, never used and never refreshed (change 37/39).
 */
export const pluginProviders: ReadonlySet<string> = new Set(["gemini-cli", "typesafe"]);

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

const emptyAnswer: RouteAnswer = { served: true, revision: 0, resolutions: new Map() };
// A resolve answers in well under a second; it never holds a membership step for long.
const resolveMs = 5_000;
const writeMs = 30_000;
const within = (ms: number, signal?: AbortSignal) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

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
    return raw === undefined ? { served: false, pools: [] } : Schema.decodeUnknownSync(State)(raw);
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
    if (!state.served) await this.storage.put(stateKey, { ...state, served: true } satisfies State);
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
  private async apply(routes: ReadonlyMap<string, Decision>, signal: AbortSignal) {
    const credentials = await readCredentials(this.home, signal);
    let failed = false;
    for (const [reference, decision] of routes) {
      if (decision === "keep") continue;
      const credential = credentials.get(reference);
      // The owner is known before Home names the route, even for a credential Home hasn't shown yet.
      if (decision !== "hold" && decision !== null) await this.record(reference, decision);
      if (!credential) {
        if (decision === null) await this.record(reference, null);
        continue;
      }
      // A hold never replaces a route another pool already gave the credential.
      if (decision === "hold" && credential.proxy.includes(routePeerAddress)) continue;
      const proxy =
        decision === "hold"
          ? routeProxyUrl(unassignedRoute)
          : credentialProxy(decision?.routeId ?? null, credential.proxy);
      try {
        const plugin = credential.kind === "auth" && pluginProviders.has(credential.provider);
        // Disabled before its proxy changes, so a refused plugin credential is never live routed.
        if (plugin && decision !== null && !credential.disabled) {
          await writeDisabled(this.home, reference, true, signal);
          await this.storage.put(refusedPrefix + reference, true);
        }
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
      } catch {
        failed = true;
      }
    }
    if (failed) return unavailable();
  }

  /**
   * Called before a pool's membership is reconciled, so its new members are routed before Home
   * lets them serve. It never fails the membership step on a resolve: only new members whose
   * owner has rules are then held on the refusing route, everyone else serves as on main, and the
   * next pass resolves them again. It reads storage by key and touches Home only when a route,
   * a hold or a hold to clear is at stake.
   */
  async prepare(scope: RouteScope, accounts: readonly string[], signal?: AbortSignal) {
    const raw = await this.storage.get(poolPrefix + scope.pool);
    const record = raw === undefined ? undefined : Schema.decodeUnknownSync(PoolRecord)(raw);
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
      for (const reference of added) {
        const stored = await this.storage.get(entryPrefix + reference);
        const entry = stored === undefined ? undefined : Schema.decodeUnknownSync(Entry)(stored);
        const rules = await this.hasRules(reference);
        // Before any 200, the host's hasRules is the only proof of rules: never direct then.
        const decision: Decision = ruleless.has(reference)
          ? null
          : answer
            ? !answer.served && rules
              ? "hold"
              : combine([answer.resolutions.get(reference), entry])
            : rules
              ? "hold"
              : "keep";
        if (decision !== "keep" && (decision !== null || entry || rules))
          atStake.set(reference, decision);
      }
      if (atStake.size) await this.apply(atStake, within(writeMs, signal));
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
   * - The host's pool-free route is written at once; a malformed one answers 503.
   * - An owner with rules: every pool here is asked; if none claims it yet, or the pools
   *   disagree, it waits on the refusing route, and a failed resolve answers 503.
   * - Anyone else, or a host that sends no hint, is mirrored exactly as before with no resolve
   *   call; without a hint a route its membership step already assigned is kept.
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
      return entry ? routeProxyUrl(entry.routeId) : undefined;
    }
    if (hint.hasRules === false) {
      await this.record(reference, null);
      return undefined;
    }
    if (hint.hasRules === undefined) {
      // A re-mirror never drops a credential its membership step routed.
      const stored = await this.storage.get(entryPrefix + reference);
      const kept = stored === undefined ? undefined : Schema.decodeUnknownSync(Entry)(stored);
      return kept ? routeProxyUrl(kept.routeId) : undefined;
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
    if (decision === "hold" || !claimed || !served) return routeProxyUrl(unassignedRoute);
    await this.record(reference, decision);
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
  async settleSignIn(session: string, references: readonly string[]) {
    const raw = await this.storage.get(signInPrefix + session);
    if (raw === undefined) return;
    const route = Schema.decodeUnknownSync(Entry)(raw);
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
    await this.record(reference, null);
  }

  /** On the pool's alarm: one cheap poll per pool, a full pass when a revision or the floor says so. */
  async tick(signal: AbortSignal) {
    const state = await this.state();
    if (
      this.now() - (state.polledAt ?? -Infinity) <
      (state.served ? servedPollMs : unservedPauseMs)
    )
      return;
    await this.storage.put(stateKey, { ...state, polledAt: this.now() } satisfies State);
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
    await this.apply(routes, signal);
    const at = this.now();
    for (const [pool, record] of pools)
      await this.storage.put(poolPrefix + pool, {
        ...record,
        revision: revisions.get(pool)!,
        refreshedAt: at,
      } satisfies PoolRecord);
  }
}
