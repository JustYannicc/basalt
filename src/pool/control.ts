import { accountsView } from "./accounts-view.ts";
import { mapBounded } from "./bounded.ts";
import providers from "./providers.json" with { type: "json" };
import {
  callerHeader,
  controlBasePath as base,
  type ControlErrorCode,
  type PoolView,
  type SignInFlow,
  type SignInStarted,
  type SignInStatus,
  type UsageRecord,
  type UsageResponse,
} from "../../apps/pool/contract.ts";
import { callbackOrigin } from "../../apps/pool/sign-in.ts";
import { openEnvelope, signEnvelope, verifyPoolToken } from "./token.ts";
import { exportLoginFile } from "./login-export.ts";
import { timePoolRead } from "./read-timing.ts";
import type { QuotaCollection } from "./quota-collection.ts";
import { checkAccount } from "./account-check.ts";
import { homeResponse } from "./home-response.ts";

import { BackendFailure, ControlFailure, fail, failureResponse, json, object, post, rows, text, unavailable, type Json } from "./json.ts";
import { emitProductEvent, type ProductEventCallback } from "../setup/product-events.ts";

export { accountsView } from "./accounts-view.ts";

export interface HomeDependencies {
  signingKey: string;
  previousSigningKey?: string;
  home: (path: string, init?: RequestInit) => Promise<Response>;
  onProductEvent?: ProductEventCallback;
  now?: () => Date;
  /** Keep best-effort work alive after a response without holding the attribution queue. */
  defer?: (work: Promise<void>) => void;
  /** Current pool audience projected by the host's existing access adapter. */
  audience?: (pool: string) => Promise<readonly string[]>;
}
/** Only the operations the routes need. Read-only requests pass null explicitly. */
export interface ControlAttribution {
  expireLocked(home: HomeClient): Promise<void>;
  reserve(home: HomeClient, provider: string, pool: string, now: Date): Promise<void>;
  discard(provider: string): Promise<void>;
  rejectedCallback(session: Session): Promise<void>;
  acceptedCallback(session: Session): Promise<void>;
  status(home: PoolHome, session: Session): Promise<SignInStatus>;
  cancel(home: PoolHome, session: Session): Promise<void>;
  started(session: Session, accountId: string): Promise<void>;
  uploadStarted(): Promise<string>;
  uploadFinished(upload: string): Promise<void>;
  retryUpload(home: PoolHome, key: string): Promise<string | undefined>;
  uploaded(home: PoolHome, id: string, upload: string, key: string): Promise<void>;
  removed(id: string): Promise<void>;
  cached(session: Session): SignInStatus | undefined;
  callback(home: HomeClient, session: Session): Promise<boolean>;
  polled(session: Session): Promise<void>;
  finished(session: Session, result?: SignInStatus): Promise<void>;
  connected(home: PoolHome, session: Session, ids: string[]): Promise<SignInStatus>;
}
export interface ControlDependencies extends HomeDependencies {
  attribution: ControlAttribution | null;
  client?: HomeClient;
  added?: (ids: string[]) => void;
  collection?: QuotaCollection;
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
// Home v1.1.6 management/quota_snapshots.go:18-19 caps each list at 200.
const quotaBatchSize = 200;
// Home v1.1.6 cluster/usage_observability.go:23.
const usageMaxLimit = 200;
interface UsageQuery { session?: string; key?: number; limit: number; status?: string }
// Match Go strings.TrimSpace, including its treatment of U+FEFF as non-whitespace.
function sessionTrim(value: string): string { return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, ""); }
async function usageSession(raw: string): Promise<string> {
  const encoder = new TextEncoder();
  const session = sessionTrim(raw);
  // Node NormalizeExplicitID checks controls before trimming.
  if (/\p{Cc}/u.test(raw) || !session || encoder.encode(session).length > 256) {
    return fail(400, "invalid_query", "Provide a valid wire session id of at most 256 bytes.");
  }
  let clean = `header:${session}`;
  const bytes = encoder.encode(clean);
  // Node v8.0.40 session/info.go:929-943 bounds before the usage queue canonicalises.
  if (bytes.length > 256) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    let end = 190;
    while ((bytes[end]! & 0xc0) === 0x80) end--;
    clean = `${new TextDecoder().decode(bytes.slice(0, end))}#${hash}`;
  }
  // Pinned node session/identity.go:57-128; plugin.go:100 writes this canonical UUID.
  const prefixes = ["lcp:v1:", "lcp:", "ctx:v1:", "ctx:", "codex:", "claude:", "header:", "session:",
    "affinity:", "slot:", "task:", "conv:", "thread:", "clientreq:", "geminicache:", "pck:", "user:", "execution:", "agy:", "derived:"];
  for (;;) {
    const prefix = prefixes.find((value) => clean.startsWith(value));
    if (!prefix) break;
    clean = sessionTrim(clean.slice(prefix.length));
  }
  if (!clean) return fail(400, "invalid_query", "This wire session id has no canonical identity.");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuid.test(clean)) return clean.toLowerCase();
  const colon = clean.indexOf(":");
  const candidate = sessionTrim(clean.slice(colon + 1));
  if (colon > 0 && uuid.test(candidate)) return candidate.toLowerCase();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`cpa:canonical-uuid:v1\0${clean}`)));
  const value = digest.slice(0, 16);
  value[6] = (value[6]! & 0x0f) | 0x80;
  value[8] = (value[8]! & 0x3f) | 0x80;
  const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
async function usageQuery(url: URL): Promise<UsageQuery> {
  const rawSession = url.searchParams.get("session");
  const rawKey = url.searchParams.get("key");
  const key = rawKey === null ? undefined : Number(rawKey);
  const rawLimit = url.searchParams.get("limit") ?? "20";
  if ((rawSession === null && key === undefined) || (rawKey !== null && (!/^[0-9]+$/.test(rawKey) || !positiveId(key)))
    || !/^[1-9][0-9]*$/.test(rawLimit)) {
    return fail(400, "invalid_query", "Provide a session or a positive key id, and a positive integer limit.");
  }
  const rawStatus = url.searchParams.get("status")?.trim().toLowerCase();
  let status = rawStatus;
  if (rawStatus !== undefined) {
    if (["success", "succeeded", "ok"].includes(rawStatus)) status = "success";
    else if (["failed", "failure", "error"].includes(rawStatus)) status = "failed";
    else if (!/^[1-5][0-9]{2}$/.test(rawStatus)) return fail(400, "invalid_query", "Provide a supported request outcome or a plain HTTP status code.");
  }
  const session = rawSession === null ? undefined : await usageSession(rawSession);
  return { session, key, limit: Math.min(usageMaxLimit, Number(rawLimit)), status };
}
function matchesUsageStatus(row: Json, status: string | undefined): boolean {
  if (!status) return true;
  const value = status.toLowerCase();
  if (["success", "succeeded", "ok"].includes(value)) return row.status === "success";
  if (["failed", "failure", "error"].includes(value)) return row.status === "failed";
  return /^[0-9]+$/.test(value) ? row.status_code === Number(value) : row.status === status;
}
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
async function signSession(secret: string, session: Session): Promise<string> {
  return signEnvelope(secret, sessionPrefix, session);
}
async function readSession(secret: string, opaque: string | null, pool: string, now: Date, previousSecret?: string): Promise<Session> {
  const value = opaque ? await openEnvelope(secret, sessionPrefix, opaque, previousSecret).catch(() => undefined) : undefined;
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
  private quotaDetails = new Map<string, { promise: Promise<Json | null>; expiresAt: number }>();
  private clock: () => number;
  constructor(fetchHome: HomeDependencies["home"], clock: () => number = Date.now) { this.fetchHome = fetchHome; this.clock = clock; }
  async response(path: string, init?: RequestInit): Promise<Response> {
    try { return await homeResponse(() => this.fetchHome(`${management}${path}`, init), init?.signal); }
    catch {
      init?.signal?.throwIfAborted();
      return unavailable();
    }
  }
  async data(path: string, init?: RequestInit): Promise<Json> {
    const response = await this.response(path, init);
    if (!response.ok) {
      if (response.status === 404) fail(404, "not_found", "The backend resource no longer exists.");
      throw new BackendFailure(response.status);
    }
    try {
      const value: unknown = await response.json();
      return object(value) ? value : unavailable();
    } catch { return unavailable(); }
  }
  async allPoolGroups(signal?: AbortSignal): Promise<Group[]> {
    const groups = rows((await this.data("/channel-groups", { signal })).channel_groups).flatMap((row) => {
      if (typeof row.channel_name !== "string" || !row.channel_name.startsWith(poolGroupPrefix)) return [];
      if (!positiveId(row.id)) return unavailable();
      return [{ id: row.id, channel_name: row.channel_name }];
    }).sort((a, b) => a.id - b.id);
    this.groupCache.clear();
    for (const group of groups) this.groupCache.set(group.channel_name, [...(this.groupCache.get(group.channel_name) ?? []), group]);
    return groups;
  }
  async poolGroups(name: string, signal?: AbortSignal): Promise<Group[]> {
    return this.groupCache.get(name) ?? (await this.allPoolGroups(signal)).filter((group) => group.channel_name === name);
  }
  invalidateGroups(): void { this.groupCache.clear(); }
  async members(groups: Group[], signal?: AbortSignal): Promise<Member[]> {
    try {
      return (await mapBounded(groups, async (group) =>
        rows((await this.data(`/channel-group-details?channel_group_id=${group.id}`, { signal })).channel_group_details).map((row) => {
          if (!positiveId(row.id) || row.channel_group_id !== group.id || !text(row.auth_id)) return unavailable();
          return { id: row.id, channel_group_id: group.id, auth_id: row.auth_id as string };
        }))).flat();
    } catch (error) { this.invalidateGroups(); throw error; }
  }
  async allMembership(): Promise<Membership> {
    const groups = await this.allPoolGroups();
    // Home accepts an empty filter and returns the complete membership table.
    const members = rows((await this.data("/channel-group-details")).channel_group_details).map((row) => {
      if (!positiveId(row.id) || !positiveId(row.channel_group_id) || !text(row.auth_id)) return unavailable();
      return { id: row.id, channel_group_id: row.channel_group_id, auth_id: row.auth_id as string };
    });
    return { groups, members };
  }
  async quota(ids: string[], detail = false): Promise<Json[]> {
    if (detail) return (await mapBounded([...new Set(ids)], (id) => this.quotaDetail(id)))
      .filter((value): value is Json => value !== null);
    const items: Json[] = [];
    for (let offset = 0; offset < ids.length; offset += quotaBatchSize) {
      const batch = ids.slice(offset, offset + quotaBatchSize);
      const query = new URLSearchParams({ ids: batch.join(","), limit: String(batch.length) });
      items.push(...rows((await this.data(`/quota/credentials?${query}`)).items));
    }
    return items;
  }
  async signInStatus(state: string): Promise<Json> {
    return this.data(`/oauth/status?state=${encodeURIComponent(state)}`);
  }
  async refreshQuota(ids: string[]): Promise<void> {
    for (const id of new Set(ids)) {
      this.dropQuotaDetail(id);
      try {
        const response = await this.response("/credentials/quota/fetch", post({ auth_index: id }));
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) return;
      } catch { /* Home's next collection can read usage. */ }
    }
  }
  dropQuotaDetail(id: string): void { this.quotaDetails.delete(id); }
  private quotaDetail(id: string): Promise<Json | null> {
    const now = this.clock();
    const cached = this.quotaDetails.get(id);
    if (cached && cached.expiresAt > now) return cached.promise;
    if (cached) this.quotaDetails.delete(id);
    const entry = { promise: undefined as unknown as Promise<Json | null>, expiresAt: Infinity };
    entry.promise = (async () => {
      const response = await this.response(`/quota/credentials/${encodeURIComponent(id)}`);
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) throw new BackendFailure(response.status);
      let value: unknown;
      try { value = await response.json(); } catch { return unavailable(); }
      if (!object(value) || !object(value.credential) || value.credential.credential_id !== id) return unavailable();
      const collection = object(value.collection) ? value.collection : undefined;
      const nextProbeAt = collection ? collection.next_probe_at : object(value.credential) ? value.credential.next_probe_at : undefined;
      const probeAt = typeof nextProbeAt === "string" ? Date.parse(nextProbeAt) : NaN;
      const refreshAt = Number.isFinite(probeAt) ? Math.min(this.clock() + 60_000, probeAt) : this.clock() + 60_000;
      if (this.quotaDetails.get(id) === entry) entry.expiresAt = refreshAt;
      return value;
    })().catch((error: unknown) => {
      if (this.quotaDetails.get(id) === entry) this.quotaDetails.delete(id);
      throw error;
    });
    this.quotaDetails.set(id, entry);
    return entry.promise;
  }
}

/** Pool membership and the public account view, with no attribution state. */
export class PoolHome {
  readonly pool: string;
  private client: HomeClient;
  private name: string;
  private added: (ids: string[]) => void;
  private onProductEvent?: ProductEventCallback;
  private accountId?: string;
  constructor(client: HomeClient, pool: string, added: (ids: string[]) => void = () => {}, onProductEvent?: ProductEventCallback, accountId?: string) {
    this.client = client;
    this.pool = pool;
    this.name = `${poolGroupPrefix}${pool}`;
    this.added = added;
    this.onProductEvent = onProductEvent;
    this.accountId = accountId;
  }
  ownMembership(all: Membership): Membership {
    const groups = all.groups.filter((group) => group.channel_name === this.name);
    const ids = new Set(groups.map((group) => group.id));
    return { groups, members: all.members.filter((member) => ids.has(member.channel_group_id)) };
  }
  async allMembership(): Promise<Membership> { return this.client.allMembership(); }
  async credentials(signal?: AbortSignal): Promise<Json[]> { return rows((await this.client.data("/credentials", { signal })).files); }
  async status(state: string): Promise<Json> { return this.client.signInStatus(state); }
  async cancel(state: string): Promise<boolean> {
    const result = await this.client.data(`/oauth/session?state=${encodeURIComponent(state)}`, { method: "DELETE" });
    if (typeof result.cancelled !== "boolean") return unavailable();
    return result.cancelled;
  }
  async membership(signal?: AbortSignal): Promise<Membership> {
    const groups = await this.client.poolGroups(this.name, signal);
    try { return { groups, members: await this.client.members(groups, signal) }; }
    catch (error) {
      if (!(error instanceof ControlFailure) || error.status !== 404) throw error;
      const fresh = (await this.client.allPoolGroups(signal)).filter((group) => group.channel_name === this.name);
      return { groups: fresh, members: await this.client.members(fresh, signal) };
    }
  }
  async add(ids: string[], known?: Membership): Promise<void> {
    if (!ids.length) return;
    let membership = known ?? await this.membership();
    if (!membership.groups.length) {
      const response = await this.client.response("/channel-groups", post({ channel_name: this.name }));
      if (response.status === 401 || response.status === 403) return unavailable();
      const created = response.ok;
      await response.body?.cancel();
      const groups = (await this.client.allPoolGroups()).filter((group) => group.channel_name === this.name);
      if (!groups.length) return unavailable();
      membership = { groups, members: await this.client.members(groups) };
      if (created && this.accountId) emitProductEvent(this.onProductEvent, "pool_created", this.accountId);
    }
    const existing = new Set(membership.members.map((member) => member.auth_id));
    for (const id of new Set(ids)) {
      if (existing.has(id)) continue;
      try { await this.client.data("/channel-group-details", post({ channel_group_id: membership.groups[0]!.id, auth_id: id })); }
      catch (error) { this.client.invalidateGroups(); throw error; }
      this.added([id]);
      if (this.accountId) emitProductEvent(this.onProductEvent, "account_connected", this.accountId);
    }
  }
  async view(isOwner: boolean): Promise<PoolView> {
    const membership = timePoolRead("membership", () => this.membership(), (value) => value.members.length);
    const [members, files, usage] = await Promise.all([
      membership,
      timePoolRead("credentials", () => this.credentials(), (value) => value.length),
      membership.then(({ members }) => timePoolRead("quota_detail", () => this.client.quota(
        [...new Set(members.map((member) => member.auth_id))].sort(), true,
      ), (value) => value.length)),
    ]);
    const ids = new Set(members.members.map((member) => member.auth_id));
    return { isOwner, providers, accounts: accountsView(files, usage, ids) };
  }
  async usage(query: UsageQuery): Promise<UsageResponse> {
    const accounts = new Set((await this.membership()).members.map((member) => member.auth_id));
    const records = new Map<string, UsageRecord>();
    if (!accounts.size) return { records: [] };
    const params = new URLSearchParams({ limit: String(usageMaxLimit), sort: "timestamp_desc" });
    if (query.session) params.set("session_id", query.session);
    if (query.key !== undefined) params.set("client_key_id", String(query.key));
    if (query.status) params.set("status", query.status);
    let offset = 0;
    let total = Infinity;
    // At most five Home pages, or 1,000 scanned rows, per request.
    for (let scannedPages = 0; scannedPages < 5 && offset < total && records.size < query.limit; scannedPages++) {
      params.set("offset", String(offset));
      const page = await this.client.data(`/usage/records?${params}`);
      const items = rows(page.items);
      if (items.length > usageMaxLimit) return unavailable();
      if (typeof page.total !== "number" || !Number.isSafeInteger(page.total) || page.total < 0) return unavailable();
      total = Math.min(total, page.total);
      if (!items.length) break;
      for (const row of items) {
        const account = object(row.credential) ? text(row.credential.credential_id) : null;
        // Compare the exact canonical key written by the node, never parent or root ids.
        if (!account || !accounts.has(account) || (query.session && row.session_id !== query.session)
          || (query.key !== undefined && (!object(row.client) || row.client.api_key_id !== query.key))
          || !matchesUsageStatus(row, query.status)) continue;
        const id = text(row.id); const status = text(row.status); const at = text(row.timestamp);
        if (!id || !status || !at || !Number.isFinite(Date.parse(at))) return unavailable();
        records.set(id, { id, account, status, at });
        if (records.size === query.limit) break;
      }
      offset += items.length;
    }
    return { records: [...records.values()] };
  }
  async remove(id: string, detached: () => Promise<void>): Promise<void> {
    const members = (await this.membership()).members.filter((member) => member.auth_id === id);
    if (!members.length) return fail(404, "not_found", "This account is not in this pool.");
    // Keep membership as retry authority until the credential deletion is acknowledged.
    const deleted = await this.client.response(`/credentials?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!deleted.ok && deleted.status !== 404) throw new BackendFailure(deleted.status);
    this.client.dropQuotaDetail(id);
    await detached();
    for (const member of members) {
      const response = await this.client.response(`/channel-group-details/${member.id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new BackendFailure(response.status);
    }
  }
}
interface RouteContext {
  request: Request;
  url: URL;
  deps: ControlDependencies;
  client: HomeClient;
  home: PoolHome;
  pool: string;
  accountId: string;
  isOwner: boolean;
  now: Date;
}
function attribution(ctx: RouteContext): ControlAttribution { return ctx.deps.attribution ?? unavailable(); }
async function sessionFor(ctx: RouteContext, opaque = ctx.url.searchParams.get("session")): Promise<Session> {
  return readSession(ctx.deps.signingKey, opaque, ctx.pool, ctx.now, ctx.deps.previousSigningKey);
}
type Route = (ctx: RouteContext) => Promise<Response>;
const routes: Record<string, Route> = {
  "POST /accounts/:id/collect": async (ctx) => {
    const caller = text(ctx.request.headers.get(callerHeader));
    if (!ctx.isOwner && (!caller || !(await ctx.deps.audience?.(ctx.pool))?.includes(caller)))
      return fail(403, "not_owner", "Only people with access to this pool can check its accounts.");
    let id: string;
    try { id = decodeURIComponent(ctx.url.pathname.slice(`${base}/accounts/`.length, -"/collect".length)); }
    catch { return fail(404, "not_found", "This account does not exist."); }
    return json(await checkAccount(ctx.home, ctx.client, ctx.deps.collection ?? unavailable(), id, ctx.request.signal));
  },
  "GET /pool": async ({ home, isOwner }) => json(await home.view(isOwner)),
  "GET /usage": async ({ home, url }) => json(await home.usage(await usageQuery(url))),
  "GET /accounts/:id/export": async ({ url, client, home }) => exportLoginFile(url, client, home),
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
      // Home returns its errors before starting a waiter. Only a lost response is ambiguous.
      await state.discard(provider);
      return unavailable();
    }
    const started: unknown = await response.json();
    if (!object(started) || !text(started.url) || !text(started.state)) return unavailable();
    const session: Session = { pool, provider, state: started.state as string, flow: detectFlow(started), expiresAt: new Date(now.getTime() + signInTtlMs).toISOString() };
    await state.started(session, ctx.accountId);
    return json({
      session: await signSession(deps.signingKey, session), provider, flow: session.flow,
      url: started.url as string, userCode: text(started.user_code) ?? (object(started.meta) ? text(started.meta.user_code) : null), expiresAt: session.expiresAt,
    } satisfies SignInStarted);
  },
  "POST /login-files": async (ctx) => {
    const state = attribution(ctx);
    const { value } = await body(ctx.request, "invalid_login_file");
    // Home v1.1.6 oauth_login.go emits each table id as metadata.type. No alias mapping.
    if (!providers.some((provider) => provider.id === value.type)) return fail(400, "invalid_login_file", "This file is not a supported OAuth login file.");
    // uuid.go:25-50 reuses a root uuid. Strip all caller-supplied credential selectors.
    const { uuid: _uuid, id: _id, auth_index: _authIndex, ...credential } = value;
    const raw = JSON.stringify(credential);
    const identity = JSON.stringify([ctx.pool, credential], (_key, entry: unknown) => object(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity)));
    const key = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const pending = await state.retryUpload(ctx.home, key);
    if (pending) return json({ accountId: pending });
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
    await state.uploaded(ctx.home, id, upload, key);
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
    if (!await state.callback(ctx.client, session)) return json({ status: "waiting" } satisfies SignInStatus);
    const response = await ctx.client.response("/oauth/callback", post({ provider: session.provider, redirect_url: value.redirectUrl }));
    if ([400, 404, 409].includes(response.status)) {
      if (response.status === 400) await state.rejectedCallback(session);
      else if (response.status === 409) await state.cancel(ctx.home, session);
      else await state.finished(session);
      return fail(400, "invalid_callback", "This callback could not be accepted. Check the URL or start again.");
    }
    if (!response.ok) return unavailable();
    await state.acceptedCallback(session);
    return json({ status: "waiting" } satisfies SignInStatus);
  },
  "DELETE /sign-ins": async (ctx) => {
    await attribution(ctx).cancel(ctx.home, await sessionFor(ctx));
    return json(null);
  },
  "GET /sign-ins/status": async (ctx) => json(await attribution(ctx).status(ctx.home, await sessionFor(ctx))),
};

/** Check the request before it can wait for, load or mutate attribution state. */
export async function authorizeControl(request: Request, signingKey: string, previousSigningKey?: string) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  const claims = bearer ? await verifyPoolToken(signingKey, bearer[1]!, previousSigningKey) : undefined;
  if (!claims) return fail(401, "unauthorized", "A valid pool token is required.");
  const url = new URL(request.url);
  const path = url.pathname.slice(base.length);
  const routePath = /^\/accounts\/[^/]+\/collect$/.test(path) ? "/accounts/:id/collect"
    : /^\/accounts\/[^/]+\/export$/.test(path) ? "/accounts/:id/export"
    : /^\/accounts\/[^/]+$/.test(path) ? "/accounts/:id" : path;
  const routeKey = `${request.method} ${routePath}`;
  const route = url.pathname.startsWith(`${base}/`) ? routes[routeKey] : undefined;
  if (!route) return fail(404, "not_found", "This pool endpoint does not exist.");
  const isOwner = request.headers.get(callerHeader) === claims.owner;
  const collect = routeKey === "POST /accounts/:id/collect";
  if (routeKey !== "GET /pool" && !collect && !isOwner) return fail(403, "not_owner", "Only the pool owner can use this endpoint.");
  const isRead = collect || routeKey === "GET /pool" || routeKey === "GET /usage" || routeKey === "GET /accounts/:id/export";
  return { claims, url, route, routeKey, isOwner, isRead };
}

export async function handleControl(request: Request, deps: ControlDependencies): Promise<Response> {
  try {
    const { claims, url, route, isOwner, isRead } = await authorizeControl(request, deps.signingKey, deps.previousSigningKey);
    const client = deps.client ?? new HomeClient(deps.home);
    const home = new PoolHome(client, claims.pool, deps.added, deps.onProductEvent, claims.owner);
    if (!isRead) await (deps.attribution ?? unavailable()).expireLocked(client);
    return await route({ request, url, deps, client, home, pool: claims.pool, accountId: claims.owner, isOwner, now: deps.now?.() ?? new Date() });
  } catch (error) { return failureResponse(error); }
}
