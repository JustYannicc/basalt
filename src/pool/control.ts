import {
  retainCollectionDiagnostic,
  type CollectionDiagnosticStorage,
} from "./collection-diagnostic.ts";
import { poolDependency } from "./dependency-failure.ts";
import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import { HomeTransportFailure } from "./json.ts";
import { accountsView, retainedAccount } from "./accounts-view.ts";
import { subscriptionAccounts } from "./subscription-accounts.ts";
import { mapBounded } from "./bounded.ts";
import { poolGroupPrefix } from "./pool-group.ts";
import providers from "./providers.json" with { type: "json" };
import {
  callerHeader,
  controlBasePath as base,
  type PoolView,
  type SignInFlow,
  type UsageRecord,
  type UsageResponse,
} from "../../apps/pool/contract.ts";
import { openEnvelope, verifyPoolToken } from "./token.ts";
import { isPoolAcquisitionPath, refusePoolAcquisition } from "./connection-policy.ts";
import { exportLoginFile } from "./login-export.ts";
import { timePoolRead } from "./read-timing.ts";
import type { HomeViewData, PoolViewSnapshots } from "./view-snapshot.ts";
import type { QuotaCollection } from "./quota-collection.ts";
import { checkAccount, readCheckedAccount } from "./account-check.ts";
import { quotaObservation } from "./quota-observation.ts";
import { publicQuotaObservation } from "./quota-observation-public.ts";
import { homeResponse } from "./home-response.ts";
import { accountActionPath, type AccountAction, type AccountActions } from "./account-actions.ts";

import {
  BackendFailure,
  ControlFailure,
  fail,
  failureResponse,
  json,
  object,
  post,
  rows,
  text,
  unavailable,
  type Json,
} from "./json.ts";
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
  cancel(home: PoolHome, session: Session): Promise<void>;
  removed(id: string, intent?: { pool: string; actor: string; at: Date }): Promise<void>;
}
export interface ControlDependencies extends HomeDependencies {
  attribution: ControlAttribution | null;
  client?: HomeClient;
  added?: (ids: string[]) => void;
  collection?: QuotaCollection;
  actions?: AccountActions;
  removals?: (pool: string) => Promise<NonNullable<PoolView["removals"]>>;
  views?: PoolViewSnapshots;
}
export interface Session {
  pool: string;
  provider: string;
  state: string;
  flow: SignInFlow;
  expiresAt: string;
}
export interface Group {
  id: number;
  channel_name: string;
}
export interface Member {
  id: number;
  channel_group_id: number;
  auth_id: string;
}
export interface Membership {
  groups: Group[];
  members: Member[];
}
export { poolGroupPrefix };
const management = "/v8/management";
const sessionPrefix = "sbs1";
// Home v1.1.6 management/quota_snapshots.go:18-19 caps each list at 200.
const quotaBatchSize = 200;
// Home v1.1.6 cluster/usage_observability.go:23.
const usageMaxLimit = 200;
interface UsageQuery {
  session?: string;
  key?: number;
  limit: number;
  status?: string;
}
// Match Go strings.TrimSpace, including its treatment of U+FEFF as non-whitespace.
function sessionTrim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
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
  const prefixes = [
    "lcp:v1:",
    "lcp:",
    "ctx:v1:",
    "ctx:",
    "codex:",
    "claude:",
    "header:",
    "session:",
    "affinity:",
    "slot:",
    "task:",
    "conv:",
    "thread:",
    "clientreq:",
    "geminicache:",
    "pck:",
    "user:",
    "execution:",
    "agy:",
    "derived:",
  ];
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
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(`cpa:canonical-uuid:v1\0${clean}`)),
  );
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
  if (
    (rawSession === null && key === undefined) ||
    (rawKey !== null && (!/^[0-9]+$/.test(rawKey) || !positiveId(key))) ||
    !/^[1-9][0-9]*$/.test(rawLimit)
  ) {
    return fail(
      400,
      "invalid_query",
      "Provide a session or a positive key id, and a positive integer limit.",
    );
  }
  const rawStatus = url.searchParams.get("status")?.trim().toLowerCase();
  let status = rawStatus;
  if (rawStatus !== undefined) {
    if (["success", "succeeded", "ok"].includes(rawStatus)) status = "success";
    else if (["failed", "failure", "error"].includes(rawStatus)) status = "failed";
    else if (!/^[1-5][0-9]{2}$/.test(rawStatus))
      return fail(
        400,
        "invalid_query",
        "Provide a supported request outcome or a plain HTTP status code.",
      );
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
async function readSession(
  secret: string,
  opaque: string | null,
  pool: string,
  now: Date,
  previousSecret?: string,
): Promise<Session> {
  const value = opaque
    ? await openEnvelope(secret, sessionPrefix, opaque, previousSecret).catch(() => undefined)
    : undefined;
  if (
    !object(value) ||
    value.pool !== pool ||
    !text(value.provider) ||
    !text(value.state) ||
    (value.flow !== "callback" && value.flow !== "device") ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now.getTime()
  ) {
    return fail(400, "invalid_session", "This sign-in has expired or is invalid. Start again.");
  }
  return value as unknown as Session;
}
/** The shared Home client has no pool identity or attribution state. */
export class HomeClient {
  private fetchHome: HomeDependencies["home"];
  private groupCache = new Map<string, Group[]>();
  private quotaDetails = new Map<string, { promise: Promise<Json | null>; expiresAt: number }>();
  private clock: () => number;
  private changed?: () => Promise<void>;
  private diagnosticStorage?: CollectionDiagnosticStorage;
  constructor(
    fetchHome: HomeDependencies["home"],
    clock: () => number = Date.now,
    changed?: () => Promise<void>,
    diagnosticStorage?: CollectionDiagnosticStorage,
  ) {
    this.fetchHome = fetchHome;
    this.clock = clock;
    this.changed = changed;
    this.diagnosticStorage = diagnosticStorage;
  }
  async response(path: string, init?: RequestInit): Promise<Response> {
    const mutation =
      init?.method !== undefined &&
      !["GET", "HEAD"].includes(init.method.toUpperCase()) &&
      /^(?:\/(?:credentials|config\/api-keys|channel-groups|channel-group-details)(?:[/?]|$)|\/oauth\/callback(?:[?]|$))/.test(
        path,
      );
    if (mutation) await this.changed?.();
    try {
      return await homeResponse(() => this.fetchHome(`${management}${path}`, init), init?.signal);
    } catch (error) {
      init?.signal?.throwIfAborted();
      throw new HomeTransportFailure(
        error instanceof PoolRuntimeUnhealthy
          ? "runtime_unhealthy"
          : error instanceof DOMException && error.name === "TimeoutError"
            ? "timeout"
            : "transport",
      );
    } finally {
      // Unknown mutation outcomes must not retain a view from before the attempt.
      if (mutation) await this.changed?.();
    }
  }
  async data(path: string, init?: RequestInit): Promise<Json> {
    const response = await this.response(path, init);
    if (!response.ok) {
      if (response.status === 404) fail(404, "not_found", "The backend resource no longer exists.");
      throw new BackendFailure(response.status);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return unavailable();
    }
    if (!object(value)) return unavailable();
    const match = /^\/quota\/credentials\/([^/?]+)$/.exec(path);
    return match ? this.retainDiagnostic(value, decodeURIComponent(match[1]!)) : value;
  }
  private retainDiagnostic(value: Json, id: string): Promise<Json> {
    if (!object(value.credential) || value.credential.credential_id !== id) return unavailable();
    return this.diagnosticStorage
      ? retainCollectionDiagnostic(value, id, this.diagnosticStorage)
      : Promise.resolve(value);
  }
  async allPoolGroups(signal?: AbortSignal): Promise<Group[]> {
    const groups = rows((await this.data("/channel-groups", { signal })).channel_groups)
      .flatMap((row) => {
        if (typeof row.channel_name !== "string" || !row.channel_name.startsWith(poolGroupPrefix))
          return [];
        if (!positiveId(row.id)) return unavailable();
        return [{ id: row.id, channel_name: row.channel_name }];
      })
      .sort((a, b) => a.id - b.id);
    this.groupCache.clear();
    for (const group of groups)
      this.groupCache.set(group.channel_name, [
        ...(this.groupCache.get(group.channel_name) ?? []),
        group,
      ]);
    return groups;
  }
  async poolGroups(name: string, signal?: AbortSignal): Promise<Group[]> {
    return (
      this.groupCache.get(name) ??
      (await this.allPoolGroups(signal)).filter((group) => group.channel_name === name)
    );
  }
  invalidateGroups(): void {
    this.groupCache.clear();
  }
  async members(groups: Group[], signal?: AbortSignal): Promise<Member[]> {
    try {
      return (
        await mapBounded(groups, async (group) =>
          rows(
            (await this.data(`/channel-group-details?channel_group_id=${group.id}`, { signal }))
              .channel_group_details,
          ).map((row) => {
            if (!positiveId(row.id) || row.channel_group_id !== group.id || !text(row.auth_id))
              return unavailable();
            return { id: row.id, channel_group_id: group.id, auth_id: row.auth_id as string };
          }),
        )
      ).flat();
    } catch (error) {
      this.invalidateGroups();
      throw error;
    }
  }
  async allMembership(signal?: AbortSignal): Promise<Membership> {
    const groups = await this.allPoolGroups(signal);
    // Home accepts an empty filter and returns the complete membership table.
    const members = rows(
      (await this.data("/channel-group-details", { signal })).channel_group_details,
    ).map((row) => {
      if (!positiveId(row.id) || !positiveId(row.channel_group_id) || !text(row.auth_id))
        return unavailable();
      return { id: row.id, channel_group_id: row.channel_group_id, auth_id: row.auth_id as string };
    });
    return { groups, members };
  }
  async quota(ids: string[], detail = false): Promise<Json[]> {
    if (detail)
      return (await mapBounded([...new Set(ids)], (id) => this.quotaDetail(id))).filter(
        (value): value is Json => value !== null,
      );
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
      } catch {
        /* Home's next collection can read usage. */
      }
    }
  }
  dropQuotaDetail(id: string): void {
    this.quotaDetails.delete(id);
  }
  private quotaDetail(id: string): Promise<Json | null> {
    const now = this.clock();
    const cached = this.quotaDetails.get(id);
    if (cached && cached.expiresAt > now) return cached.promise;
    if (cached) this.quotaDetails.delete(id);
    const entry = { promise: undefined as unknown as Promise<Json | null>, expiresAt: Infinity };
    entry.promise = (async () => {
      const response = await this.response(`/quota/credentials/${encodeURIComponent(id)}`);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) throw new BackendFailure(response.status);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return unavailable();
      }
      if (!object(value) || !object(value.credential) || value.credential.credential_id !== id)
        return unavailable();
      const collection = object(value.collection) ? value.collection : undefined;
      const nextProbeAt = collection
        ? collection.next_probe_at
        : object(value.credential)
          ? value.credential.next_probe_at
          : undefined;
      const probeAt = typeof nextProbeAt === "string" ? Date.parse(nextProbeAt) : NaN;
      const refreshAt = Number.isFinite(probeAt)
        ? Math.min(this.clock() + 60_000, probeAt)
        : this.clock() + 60_000;
      if (this.quotaDetails.get(id) === entry) entry.expiresAt = refreshAt;
      return this.retainDiagnostic(value, id);
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
  constructor(
    client: HomeClient,
    pool: string,
    added: (ids: string[]) => void = () => {},
    onProductEvent?: ProductEventCallback,
    accountId?: string,
  ) {
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
  async allMembership(signal?: AbortSignal): Promise<Membership> {
    return this.client.allMembership(signal);
  }
  async credentials(signal?: AbortSignal): Promise<Json[]> {
    return rows((await this.client.data("/credentials", { signal })).files);
  }
  async status(state: string): Promise<Json> {
    return this.client.signInStatus(state);
  }
  async cancel(state: string): Promise<boolean> {
    const result = await this.client.data(`/oauth/session?state=${encodeURIComponent(state)}`, {
      method: "DELETE",
    });
    if (typeof result.cancelled !== "boolean") return unavailable();
    return result.cancelled;
  }
  async membership(signal?: AbortSignal): Promise<Membership> {
    const groups = await this.client.poolGroups(this.name, signal);
    try {
      return { groups, members: await this.client.members(groups, signal) };
    } catch (error) {
      if (!(error instanceof ControlFailure) || error.status !== 404) throw error;
      const fresh = (await this.client.allPoolGroups(signal)).filter(
        (group) => group.channel_name === this.name,
      );
      return { groups: fresh, members: await this.client.members(fresh, signal) };
    }
  }
  async add(ids: string[], known?: Membership): Promise<void> {
    if (!ids.length) return;
    let membership = known ?? (await this.membership());
    if (!membership.groups.length) {
      const response = await this.client.response(
        "/channel-groups",
        post({ channel_name: this.name }),
      );
      if (response.status === 401 || response.status === 403) return unavailable();
      const created = response.ok;
      if (response.body) await poolDependency("membership", response.body.cancel());
      const groups = (await this.client.allPoolGroups()).filter(
        (group) => group.channel_name === this.name,
      );
      if (!groups.length) return unavailable();
      membership = { groups, members: await this.client.members(groups) };
      if (created && this.accountId)
        emitProductEvent(this.onProductEvent, "pool_created", this.accountId);
    }
    const existing = new Set(membership.members.map((member) => member.auth_id));
    for (const id of new Set(ids)) {
      if (existing.has(id)) continue;
      try {
        await this.client.data(
          "/channel-group-details",
          post({ channel_group_id: membership.groups[0]!.id, auth_id: id }),
        );
      } catch (error) {
        this.client.invalidateGroups();
        throw error;
      }
      this.added([id]);
      if (this.accountId)
        emitProductEvent(this.onProductEvent, "account_connected", this.accountId);
    }
  }
  async readView(now: () => Date): Promise<HomeViewData> {
    const readAt: HomeViewData["readAt"] = { membership: "" };
    const controller = new AbortController();
    const membership = timePoolRead(
      "membership",
      () => this.membership(),
      (value) => value.members.length,
    );
    // Start speculatively so a populated pool never serializes credentials behind membership.
    const credentials = timePoolRead(
      "credentials",
      () => this.credentials(controller.signal),
      (value) => value.length,
    ).then(
      (files) => {
        readAt.credentials = now().toISOString();
        return { files };
      },
      (error: unknown) => ({ error }),
    );
    try {
      const members = await membership;
      readAt.membership = now().toISOString();
      if (!members.members.length) return { accounts: [], readAt };
      const ids = [...new Set(members.members.map((member) => member.auth_id))].sort();
      for (const id of ids) this.client.dropQuotaDetail(id);
      const reads = [
        credentials.then((result) => {
          if ("error" in result) throw result.error;
          return result.files;
        }),
        timePoolRead(
          "quota_detail",
          () => this.client.quota(ids, true),
          (value) => value.length,
        ).then((value) => {
          readAt.quota = now().toISOString();
          return value;
        }),
      ] as const;
      await Promise.allSettled(reads);
      const [files, usage] = await Promise.all(reads);
      return { accounts: accountsView(files, usage, new Set(ids)), readAt };
    } finally {
      // homeResponse settles on abort even while container readiness or its port fetch is hung.
      controller.abort();
      await credentials;
    }
  }
  async view(
    isOwner: boolean,
    views?: PoolViewSnapshots,
    fresh = false,
    now = () => new Date(),
  ): Promise<PoolView> {
    const result = views
      ? await views.view(this.pool, fresh, () => this.readView(now))
      : { data: await this.readView(now), source: "live" as const, revalidationFailed: false };
    const accounts = result.data.accounts.map((account) =>
      result.source === "snapshot" ? retainedAccount(account, now().getTime()) : account,
    );
    return {
      isOwner,
      providers: providers.map(({ protocol, ...provider }) =>
        protocol === "typesafe-systemone" ? { ...provider, protocol } : provider,
      ),
      accounts,
      subscriptionAccountIds: subscriptionAccounts(accounts).map((account) => account.id),
      reading: {
        source: result.source,
        readAt: result.data.readAt,
        revalidationFailed: result.revalidationFailed,
      },
    };
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
    for (
      let scannedPages = 0;
      scannedPages < 5 && offset < total && records.size < query.limit;
      scannedPages++
    ) {
      params.set("offset", String(offset));
      const page = await this.client.data(`/usage/records?${params}`);
      const items = rows(page.items);
      if (items.length > usageMaxLimit) return unavailable();
      if (typeof page.total !== "number" || !Number.isSafeInteger(page.total) || page.total < 0)
        return unavailable();
      total = Math.min(total, page.total);
      if (!items.length) break;
      for (const row of items) {
        const account = object(row.credential) ? text(row.credential.credential_id) : null;
        // Compare the exact canonical key written by the node, never parent or root ids.
        if (
          !account ||
          !accounts.has(account) ||
          (query.session && row.session_id !== query.session) ||
          (query.key !== undefined &&
            (!object(row.client) || row.client.api_key_id !== query.key)) ||
          !matchesUsageStatus(row, query.status)
        )
          continue;
        const id = text(row.id);
        const status = text(row.status);
        const at = text(row.timestamp);
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
    const deleted = await this.client.response(`/credentials?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!deleted.ok && deleted.status !== 404) throw new BackendFailure(deleted.status);
    this.client.dropQuotaDetail(id);
    await detached();
    for (const member of members) {
      const response = await this.client.response(`/channel-group-details/${member.id}`, {
        method: "DELETE",
      });
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
function attribution(ctx: RouteContext): ControlAttribution {
  return ctx.deps.attribution ?? unavailable();
}
async function sessionFor(
  ctx: RouteContext,
  opaque = ctx.url.searchParams.get("session"),
): Promise<Session> {
  return readSession(ctx.deps.signingKey, opaque, ctx.pool, ctx.now, ctx.deps.previousSigningKey);
}
type Route = (ctx: RouteContext) => Promise<Response>;
const routes: Record<string, Route> = {
  "POST /accounts/:id/action": async (ctx) => accountAction(ctx),
  "GET /accounts/:id/resets": async (ctx) => accountAction(ctx),
  "POST /accounts/:id/collect": async (ctx) => {
    const caller = text(ctx.request.headers.get(callerHeader));
    if (!ctx.isOwner && (!caller || !(await ctx.deps.audience?.(ctx.pool))?.includes(caller)))
      return fail(403, "not_owner", "Only people with access to this pool can check its accounts.");
    let id: string;
    try {
      id = decodeURIComponent(
        ctx.url.pathname.slice(`${base}/accounts/`.length, -"/collect".length),
      );
    } catch {
      return fail(404, "not_found", "This account does not exist.");
    }
    return json(
      await checkAccount(
        ctx.home,
        ctx.client,
        ctx.deps.collection ?? unavailable(),
        id,
        ctx.request.signal,
      ),
    );
  },
  "GET /accounts/:id/observations": (ctx) => observeAccount(ctx, false),
  "POST /accounts/:id/observations/refresh": (ctx) => observeAccount(ctx, true),
  "GET /pool": async ({ home, isOwner, deps, pool, url }) => {
    const view = await home.view(
      isOwner,
      deps.views,
      url.searchParams.get("fresh") === "true",
      deps.now,
    );
    return json(isOwner && deps.removals ? { ...view, removals: await deps.removals(pool) } : view);
  },
  "GET /usage": async ({ home, url }) => json(await home.usage(await usageQuery(url))),
  "GET /accounts/:id/export": async ({ url, client, home }) => exportLoginFile(url, client, home),
  "POST /sign-ins": async (ctx) => refusePoolAcquisition(ctx.pool),
  "POST /login-files": async (ctx) => refusePoolAcquisition(ctx.pool),
  "DELETE /accounts/:id": async (ctx) => {
    let id: string;
    try {
      id = decodeURIComponent(ctx.url.pathname.slice(`${base}/accounts/`.length));
    } catch {
      return fail(404, "not_found", "This account does not exist.");
    }
    await ctx.home.remove(id, () =>
      attribution(ctx).removed(id, {
        pool: ctx.pool,
        actor: ctx.accountId,
        at: ctx.deps.now?.() ?? new Date(),
      }),
    );
    return json(null);
  },
  "POST /sign-ins/callback": async (ctx) => refusePoolAcquisition(ctx.pool),
  "DELETE /sign-ins": async (ctx) => {
    await attribution(ctx).cancel(ctx.home, await sessionFor(ctx));
    return json(null);
  },
  "GET /sign-ins/status": async (ctx) => refusePoolAcquisition(ctx.pool),
};

async function observeAccount(ctx: RouteContext, refresh: boolean): Promise<Response> {
  const match = /^\/accounts\/([^/]+)\/observations(?:\/refresh)?$/.exec(
    ctx.url.pathname.slice(base.length),
  );
  let id: string;
  try {
    id = decodeURIComponent(match?.[1] ?? "");
  } catch {
    return fail(404, "not_found", "This account does not exist.");
  }
  const { account, quota } = await readCheckedAccount(
    ctx.home,
    ctx.client,
    ctx.deps.collection ?? unavailable(),
    id,
    ctx.request.signal,
    refresh,
  );
  return json({
    account,
    observation: quota === null ? null : publicQuotaObservation(quotaObservation(quota)),
  });
}

async function accountAction(ctx: RouteContext): Promise<Response> {
  const match = accountActionPath.exec(ctx.url.pathname.slice(base.length));
  if (!match) return fail(404, "not_found", "This pool endpoint does not exist.");
  if (match[2] === "refresh" && !ctx.isOwner) {
    const caller = text(ctx.request.headers.get(callerHeader));
    if (!caller || !(await ctx.deps.audience?.(ctx.pool))?.includes(caller)) {
      return fail(
        403,
        "not_owner",
        "Only people with access to this pool can refresh its accounts.",
      );
    }
  }
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return fail(400, "invalid_query", "Provide a valid account id.");
  }
  return (ctx.deps.actions ?? unavailable()).handle(
    ctx.home,
    id,
    match[2] as AccountAction,
    ctx.request,
  );
}

/** Check the request before it can wait for, load or mutate attribution state. */
export async function authorizeControl(
  request: Request,
  signingKey: string,
  previousSigningKey?: string,
) {
  const bearer = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  const claims = bearer
    ? await verifyPoolToken(signingKey, bearer[1]!, previousSigningKey)
    : undefined;
  if (!claims) return fail(401, "unauthorized", "A valid pool token is required.");
  const url = new URL(request.url);
  const path = url.pathname.slice(base.length);
  const action = accountActionPath.exec(path);
  const routePath = action
    ? action[2] === "resets" || action[2] === "resets/attempt"
      ? "/accounts/:id/resets"
      : "/accounts/:id/action"
    : /^\/accounts\/[^/]+\/observations\/refresh$/.test(path)
      ? "/accounts/:id/observations/refresh"
      : /^\/accounts\/[^/]+\/observations$/.test(path)
        ? "/accounts/:id/observations"
        : /^\/accounts\/[^/]+\/collect$/.test(path)
          ? "/accounts/:id/collect"
          : /^\/accounts\/[^/]+\/export$/.test(path)
            ? "/accounts/:id/export"
            : /^\/accounts\/[^/]+$/.test(path)
              ? "/accounts/:id"
              : path;
  const routeKey = `${request.method} ${routePath}`;
  const route = url.pathname.startsWith(`${base}/`) ? routes[routeKey] : undefined;
  if (!route) return fail(404, "not_found", "This pool endpoint does not exist.");
  const isOwner = request.headers.get(callerHeader) === claims.owner;
  const collect = routeKey === "POST /accounts/:id/collect";
  const refresh = action?.[2] === "refresh" && request.method === "POST";
  if (routeKey !== "GET /pool" && !collect && !refresh && !isOwner)
    return fail(403, "not_owner", "Only the pool owner can use this endpoint.");
  // Old app deployments and tools can still call these routes. Refuse before loading the
  // attribution queue, reading a body or letting a status read finalize a credential.
  if (isPoolAcquisitionPath(request.method, url.pathname)) refusePoolAcquisition(claims.pool);
  const observation =
    routeKey === "GET /accounts/:id/observations" ||
    routeKey === "POST /accounts/:id/observations/refresh";
  const isRead =
    collect ||
    observation ||
    routeKey === "GET /pool" ||
    routeKey === "GET /usage" ||
    routeKey === "GET /accounts/:id/export";
  return { claims, url, route, routeKey, isOwner, isRead, isAccountAction: !!action };
}

export async function handleControl(
  request: Request,
  deps: ControlDependencies,
): Promise<Response> {
  try {
    const { claims, url, route, routeKey, isOwner, isRead, isAccountAction } =
      await authorizeControl(request, deps.signingKey, deps.previousSigningKey);
    const client = deps.client ?? new HomeClient(deps.home);
    const home = new PoolHome(client, claims.pool, deps.added, deps.onProductEvent, claims.owner);
    if (!isRead && !isAccountAction) await (deps.attribution ?? unavailable()).expireLocked(client);
    const changesAccount = request.method === "POST" && routeKey.startsWith("POST /accounts/");
    if (changesAccount) await deps.views?.invalidate();
    try {
      return await route({
        request,
        url,
        deps,
        client,
        home,
        pool: claims.pool,
        accountId: claims.owner,
        isOwner,
        now: deps.now?.() ?? new Date(),
      });
    } finally {
      if (changesAccount) await deps.views?.invalidate();
    }
  } catch (error) {
    return failureResponse(error);
  }
}
