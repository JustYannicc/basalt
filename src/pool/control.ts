import providers from "./providers.json" with { type: "json" };
import {
  type Account,
  callerHeader,
  controlBasePath as base,
  type ControlErrorCode,
  type PoolView,
  type SignInFlow,
  type SignInStarted,
  type SignInStatus,
  type UsageWindow,
} from "../../apps/pool/contract.ts";
import { callbackOrigin } from "../../apps/pool/sign-in.ts";
import { openEnvelope, signEnvelope, verifyPoolToken } from "./token.ts";

import { ControlFailure, fail, json, object, post, rows, text, unavailable, unavailableResponse, type Json } from "./json.ts";

export interface HomeDependencies {
  signingKey: string;
  home: (path: string, init?: RequestInit) => Promise<Response>;
  now?: () => Date;
  /** Keep best-effort work alive after a response without holding the attribution queue. */
  defer?: (work: Promise<void>) => void;
}
/** Only the operations the routes need. Read-only requests pass null explicitly. */
export interface ControlAttribution {
  expireLocked(home: HomeClient): Promise<void>;
  reserve(home: HomeClient, provider: string, pool: string, now: Date): Promise<void>;
  discard(provider: string): Promise<void>;
  started(session: Session): Promise<void>;
  uploadStarted(): Promise<string>;
  uploadFinished(upload: string): Promise<void>;
  uploaded(home: PoolHome, id: string, upload: string): Promise<void>;
  removed(id: string): Promise<void>;
  cached(session: Session): SignInStatus | undefined;
  callback(home: HomeClient, session: Session): Promise<void>;
  polled(session: Session): Promise<void>;
  finished(session: Session, result?: SignInStatus): Promise<void>;
  connected(home: PoolHome, session: Session, ids: string[]): Promise<SignInStatus>;
}
export interface ControlDependencies extends HomeDependencies {
  attribution: ControlAttribution | null;
  client?: HomeClient;
  added?: (ids: string[]) => void;
}
export interface Session {
  pool: string;
  provider: string;
  state: string;
  flow: SignInFlow;
  expiresAt: string;
}
export interface Group { id: number; channel_name: string }
export interface Member { id: number; channel_group_id: number; auth_id: string }
export interface Membership { groups: Group[]; members: Member[] }
export const poolGroupPrefix = "signalbox-pool-";
export const signInTtlMs = 20 * 60_000;
const management = "/v8/management";
const sessionPrefix = "sbs1";
const memberConcurrency = 4;
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
async function signSession(secret: string, session: Session): Promise<string> {
  return signEnvelope(secret, sessionPrefix, session);
}
async function readSession(secret: string, opaque: string | null, pool: string, now: Date): Promise<Session> {
  const value = opaque ? await openEnvelope(secret, sessionPrefix, opaque).catch(() => undefined) : undefined;
  if (!object(value) || value.pool !== pool || !text(value.provider) || !text(value.state)
    || (value.flow !== "callback" && value.flow !== "device") || typeof value.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now.getTime()) {
    return fail(400, "invalid_session", "This sign-in has expired or is invalid. Start again.");
  }
  return value as unknown as Session;
}
function detectFlow(value: Json): SignInFlow {
  if (value.flow === "device") return "device";
  if (value.flow === "browser" || value.flow === "callback") return "callback";
  // A sign-in that ends on a local page needs its address pasted back; any other finishes itself.
  return callbackOrigin(String(value.url)) ? "callback" : "device";
}
async function body(request: Request, code: ControlErrorCode): Promise<{ raw: string; value: Json }> {
  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) {
        void reader.cancel().catch(() => {});
        throw new Error("Body too large");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const value: unknown = JSON.parse(raw);
    if (!object(value)) throw new Error("Expected object");
    return { raw, value };
  } catch {
    return fail(400, code, "Provide a valid JSON object no larger than 1 MiB.");
  }
}
/** The shared Home client has no pool identity or attribution state. */
export class HomeClient {
  private fetchHome: HomeDependencies["home"];
  private groupCache = new Map<string, Group[]>();
  constructor(fetchHome: HomeDependencies["home"]) { this.fetchHome = fetchHome; }
  async response(path: string, init?: RequestInit): Promise<Response> {
    try { return await this.fetchHome(`${management}${path}`, init); } catch { return unavailable(); }
  }
  async data(path: string, init?: RequestInit): Promise<Json> {
    const response = await this.response(path, init);
    if (!response.ok) {
      if (response.status === 404) fail(404, "not_found", "The backend resource no longer exists.");
      return unavailable();
    }
    try {
      const value: unknown = await response.json();
      return object(value) ? value : unavailable();
    } catch { return unavailable(); }
  }
  async allPoolGroups(): Promise<Group[]> {
    const groups = rows((await this.data("/channel-groups")).channel_groups).flatMap((row) => {
      if (typeof row.channel_name !== "string" || !row.channel_name.startsWith(poolGroupPrefix)) return [];
      if (!positiveId(row.id)) return unavailable();
      return [{ id: row.id, channel_name: row.channel_name }];
    }).sort((a, b) => a.id - b.id);
    this.groupCache.clear();
    for (const group of groups) this.groupCache.set(group.channel_name, [...(this.groupCache.get(group.channel_name) ?? []), group]);
    return groups;
  }
  async poolGroups(name: string): Promise<Group[]> {
    return this.groupCache.get(name) ?? (await this.allPoolGroups()).filter((group) => group.channel_name === name);
  }
  invalidateGroups(): void { this.groupCache.clear(); }
  async members(groups: Group[]): Promise<Member[]> {
    const results: Member[][] = Array.from({ length: groups.length }, () => []);
    let next = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(memberConcurrency, groups.length) }, async () => {
        for (;;) {
          const index = next++;
          const group = groups[index];
          if (!group) return;
          results[index] = rows((await this.data(`/channel-group-details?channel_group_id=${group.id}`)).channel_group_details).map((row) => {
            if (!positiveId(row.id) || row.channel_group_id !== group.id || !text(row.auth_id)) return unavailable();
            return { id: row.id, channel_group_id: group.id, auth_id: row.auth_id as string };
          });
        }
      }));
      return results.flat();
    } catch (error) { this.invalidateGroups(); throw error; }
  }
  async allMembership(): Promise<Membership> {
    const groups = await this.allPoolGroups();
    return { groups, members: await this.members(groups) };
  }
  async refreshQuota(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      try {
        const response = await this.response("/credentials/quota/fetch", post({ auth_index: id }));
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) return;
      } catch { /* Home's next collection can read usage. */ }
    }
  }
}

/** Pool membership and the public account view, with no attribution state. */
export class PoolHome {
  private client: HomeClient;
  private name: string;
  private added: (ids: string[]) => void;
  constructor(client: HomeClient, pool: string, added: (ids: string[]) => void = () => {}) {
    this.client = client;
    this.name = `${poolGroupPrefix}${pool}`;
    this.added = added;
  }
  ownMembership(all: Membership): Membership {
    const groups = all.groups.filter((group) => group.channel_name === this.name);
    const ids = new Set(groups.map((group) => group.id));
    return { groups, members: all.members.filter((member) => ids.has(member.channel_group_id)) };
  }
  async allMembership(): Promise<Membership> { return this.client.allMembership(); }
  async credentials(): Promise<Json[]> { return rows((await this.client.data("/credentials")).files); }
  async membership(): Promise<Membership> {
    const groups = await this.client.poolGroups(this.name);
    try { return { groups, members: await this.client.members(groups) }; }
    catch (error) {
      if (!(error instanceof ControlFailure) || error.status !== 404) throw error;
      const fresh = (await this.client.allPoolGroups()).filter((group) => group.channel_name === this.name);
      return { groups: fresh, members: await this.client.members(fresh) };
    }
  }
  async add(ids: string[], known?: Membership): Promise<void> {
    if (!ids.length) return;
    let membership = known ?? await this.membership();
    if (!membership.groups.length) {
      const response = await this.client.response("/channel-groups", post({ channel_name: this.name }));
      if (response.status === 401 || response.status === 403) return unavailable();
      const groups = (await this.client.allPoolGroups()).filter((group) => group.channel_name === this.name);
      if (!groups.length) return unavailable();
      membership = { groups, members: await this.client.members(groups) };
    }
    const existing = new Set(membership.members.map((member) => member.auth_id));
    for (const id of new Set(ids)) {
      if (existing.has(id)) continue;
      try { await this.client.data("/channel-group-details", post({ channel_group_id: membership.groups[0]!.id, auth_id: id })); }
      catch (error) { this.client.invalidateGroups(); throw error; }
      this.added([id]);
    }
  }
  async view(isOwner: boolean): Promise<PoolView> {
    const ids = new Set((await this.membership()).members.map((member) => member.auth_id));
    if (!ids.size) return { isOwner, providers, accounts: [] };
    const [files, usage] = await Promise.all([
      this.credentials(),
      this.client.data(`/quota/credentials?ids=${encodeURIComponent([...ids].sort().join(","))}`),
    ]);
    const credentials = files.filter((row) => typeof row.id === "string" && ids.has(row.id));
    const byId = new Map(rows(usage.items).map((row) => [row.credential_id, row]));
    const accounts = credentials.map((row): Account => {
      const quota = byId.get(row.id);
      return {
        id: row.id as string, provider: text(row.provider) ?? text(row.type) ?? "",
        label: text(row.email) ?? text(row.label) ?? text(row.name) ?? row.id as string,
        plan: object(quota?.plan) ? text(quota.plan.name) : null,
        state: row.disabled ? "disabled" : row.unavailable ? "unavailable" : row.status === "error" ? "error" : "active",
        message: text(row.status_message),
        windows: Array.isArray(quota?.primary_windows) ? rows(quota.primary_windows).map(windowView) : [],
        observedAt: text(quota?.observed_at),
      };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return { isOwner, providers, accounts };
  }
  async remove(id: string, detached: () => Promise<void>): Promise<void> {
    const members = (await this.membership()).members.filter((member) => member.auth_id === id);
    if (!members.length) return fail(404, "not_found", "This account is not in this pool.");
    for (const member of members) await this.client.data(`/channel-group-details/${member.id}`, { method: "DELETE" });
    await detached();
    await this.client.data(`/credentials?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function windowView(row: Json): UsageWindow {
  const ratio = finite(row.remaining_ratio) ? row.remaining_ratio : finite(row.used_ratio) ? 1 - row.used_ratio : null;
  return {
    id: text(row.id) ?? "", label: text(row.label) ?? text(row.id) ?? "",
    remainingRatio: row.is_unlimited === true ? 1 : ratio === null ? null : Math.min(1, Math.max(0, ratio)),
    resetAt: row.is_unlimited === true ? null : text(row.reset_at),
    windowSeconds: finite(row.window_seconds) ? row.window_seconds : null,
  };
}

interface RouteContext {
  request: Request;
  url: URL;
  deps: ControlDependencies;
  client: HomeClient;
  home: PoolHome;
  pool: string;
  isOwner: boolean;
  now: Date;
}
function attribution(ctx: RouteContext): ControlAttribution { return ctx.deps.attribution ?? unavailable(); }
async function sessionFor(ctx: RouteContext, opaque = ctx.url.searchParams.get("session")): Promise<Session> {
  return readSession(ctx.deps.signingKey, opaque, ctx.pool, ctx.now);
}
type Route = (ctx: RouteContext) => Promise<Response>;
const routes: Record<string, Route> = {
  "GET /pool": async ({ home, isOwner }) => json(await home.view(isOwner)),
  "POST /sign-ins": async (ctx) => {
    const { request, client, pool, now, deps } = ctx;
    const state = attribution(ctx);
    const { value } = await body(request, "unknown_provider");
    if (!providers.some((provider) => provider.id === value.provider)) return fail(400, "unknown_provider", "Choose a provider from this pool's provider list.");
    const provider = value.provider as string;
    await state.reserve(client, provider, pool, now);
    const response = await client.response(`/oauth/auth-url?provider=${encodeURIComponent(provider)}`);
    if (response.status === 404) {
      await state.discard(provider);
      return fail(400, "unknown_provider", "This provider is not available.");
    }
    if (!response.ok) {
      // A rejected start cannot exchange a credential. An ambiguous failure retains the lock.
      if (response.status >= 400 && response.status < 500) await state.discard(provider);
      return unavailable();
    }
    const started: unknown = await response.json();
    if (!object(started) || !text(started.url) || !text(started.state)) return unavailable();
    const session: Session = { pool, provider, state: started.state as string, flow: detectFlow(started), expiresAt: new Date(now.getTime() + signInTtlMs).toISOString() };
    await state.started(session);
    return json({
      session: await signSession(deps.signingKey, session), provider, flow: session.flow,
      url: started.url as string, userCode: text(started.user_code) ?? (object(started.meta) ? text(started.meta.user_code) : null), expiresAt: session.expiresAt,
    } satisfies SignInStarted);
  },
  "POST /login-files": async (ctx) => {
    const state = attribution(ctx);
    const { raw } = await body(ctx.request, "invalid_login_file");
    const upload = await state.uploadStarted();
    const response = await ctx.client.response("/credentials", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
    if (response.status === 400) {
      await state.uploadFinished(upload);
      return fail(400, "invalid_login_file", "This file is not a supported OAuth login file.");
    }
    if (!response.ok) return unavailable();
    const saved: unknown = await response.json();
    if (!object(saved) || typeof saved.name !== "string" || !saved.name.endsWith(".json") || saved.name.length <= 5) return unavailable();
    const id = saved.name.slice(0, -5);
    await state.uploaded(ctx.home, id, upload);
    return json({ accountId: id });
  },
  "DELETE /accounts/:id": async (ctx) => {
    let id: string;
    try { id = decodeURIComponent(ctx.url.pathname.slice(`${base}/accounts/`.length)); }
    catch { return fail(404, "not_found", "This account does not exist."); }
    await ctx.home.remove(id, () => attribution(ctx).removed(id));
    return json(null);
  },
  "POST /sign-ins/callback": async (ctx) => {
    const value = (await body(ctx.request, "invalid_callback")).value;
    const session = await sessionFor(ctx, text(value.session));
    if (session.flow !== "callback" || !text(value.redirectUrl)) return fail(400, "invalid_callback", "Paste the callback URL for this sign-in.");
    try {
      if (new URL(value.redirectUrl as string).searchParams.get("state") !== session.state) throw new Error("Wrong state");
    } catch { return fail(400, "invalid_callback", "This callback belongs to a different sign-in."); }
    const state = attribution(ctx);
    await state.callback(ctx.client, session);
    const response = await ctx.client.response("/oauth/callback", post({ provider: session.provider, redirect_url: value.redirectUrl }));
    if ([400, 404, 409].includes(response.status)) {
      if (response.status !== 409) await state.finished(session);
      return fail(400, "invalid_callback", "This callback could not be accepted. Check the URL or start again.");
    }
    if (!response.ok) return unavailable();
    return json({ status: "waiting" } satisfies SignInStatus);
  },
  "DELETE /sign-ins": async (ctx) => {
    const session = await sessionFor(ctx);
    const state = attribution(ctx);
    state.cached(session);
    const response = await ctx.client.response(`/oauth/session?state=${encodeURIComponent(session.state)}`, { method: "DELETE" });
    if (response.status === 404) {
      await state.finished(session);
      return fail(400, "invalid_session", "This sign-in no longer exists.");
    }
    if (!response.ok) return unavailable();
    await state.finished(session);
    return json(null);
  },
  "GET /sign-ins/status": async (ctx) => {
    const session = await sessionFor(ctx);
    const state = attribution(ctx);
    const cached = state.cached(session);
    if (cached) return json(cached);
    await state.polled(session);
    const response = await ctx.client.response(`/oauth/status?state=${encodeURIComponent(session.state)}`);
    if (response.status === 404) {
      await state.finished(session);
      return fail(400, "invalid_session", "This sign-in no longer exists.");
    }
    if (!response.ok) return unavailable();
    const status: unknown = await response.json();
    if (!object(status)) return unavailable();
    if (status.status === "wait") return json({ status: "waiting" } satisfies SignInStatus);
    if (status.status === "error") {
      const failed: SignInStatus = { status: "failed", message: "Sign-in failed. Start again and approve access on the provider's page." };
      await state.finished(session, failed);
      return json(failed);
    }
    if (status.status !== "ok") return unavailable();
    const ids = Array.isArray(status.auth_ids) ? status.auth_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    if (text(status.auth_id)) ids.push(status.auth_id as string);
    return json(await state.connected(ctx.home, session, ids));
  },
};

export async function handleControl(request: Request, deps: ControlDependencies): Promise<Response> {
  try {
    const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
    const claims = bearer ? await verifyPoolToken(deps.signingKey, bearer[1]!) : undefined;
    if (!claims) return fail(401, "unauthorized", "A valid pool token is required.");
    const url = new URL(request.url);
    const path = url.pathname.slice(base.length);
    const routePath = /^\/accounts\/[^/]+$/.test(path) ? "/accounts/:id" : path;
    const routeKey = `${request.method} ${routePath}`;
    const route = url.pathname.startsWith(`${base}/`) ? routes[routeKey] : undefined;
    if (!route) return fail(404, "not_found", "This pool endpoint does not exist.");
    const isOwner = request.headers.get(callerHeader) === claims.owner;
    if (routeKey !== "GET /pool" && !isOwner) return fail(403, "not_owner", "Only the pool owner can change accounts or sign-ins.");
    const client = deps.client ?? new HomeClient(deps.home);
    const home = new PoolHome(client, claims.pool, deps.added);
    if (routeKey !== "GET /pool") await (deps.attribution ?? unavailable()).expireLocked(client);
    return await route({ request, url, deps, client, home, pool: claims.pool, isOwner, now: deps.now?.() ?? new Date() });
  } catch (error) {
    if (error instanceof ControlFailure) {
      const response = json({ error: error.code, message: error.message }, error.status);
      if (error.code === "busy") response.headers.set("Retry-After", "10");
      return response;
    }
    return unavailableResponse();
  }
}
