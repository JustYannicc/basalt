import { callbackOrigin } from "../../apps/pool/sign-in.ts";
import providers from "./providers.json" with { type: "json" };
import type { HomeClient } from "./control.ts";
import { object, post, readBody, rows, text, unavailable } from "./json.ts";
import { openEnvelope } from "./token.ts";
import { accountAcquisitionPrefix as prefix } from "./account-acquisition-contract.ts";
import { homeReference, homeReferences } from "./home-references.ts";

const storageKey = "pool-account-acquisitions-v1";
const ttl = 20 * 60_000;

interface Attempt {
  owner: string;
  provider: string;
  operation: string;
  expires: number;
  marker: string;
  before: string[];
  reconnect?: string;
  settled?: boolean;
  observed?: string[];
  state?: string;
  started?: { session: string; url: string; code?: string; expiresAt: number; paste?: { label: string } };
  result?: { state: "connected"; ref: string } | { state: "failed"; message: string };
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
}
interface Attribution {
  begin(): Promise<string>;
  settle(marker: string, ids: readonly string[]): Promise<void>;
}

/** Runs inside PoolControl's queue, including its legacy attribution writes. No pool is attached. */
export class HomeAccountAcquisitions {
  private storage: Storage;
  private home: HomeClient;
  private signingKey: string;
  private attribution: Attribution;
  private previousSigningKey: string | undefined;
  private now: () => number;

  constructor(
    storage: Storage,
    home: HomeClient,
    signingKey: string,
    attribution: Attribution,
    previousSigningKey?: string,
    now = Date.now,
  ) {
    this.storage = storage;
    this.home = home;
    this.signingKey = signingKey;
    this.attribution = attribution;
    this.previousSigningKey = previousSigningKey;
    this.now = now;
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let value: unknown;
    try {
      const bytes = await readBody(request, 32_768);
      if (bytes === undefined) throw new Error("Body too large");
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
      if (!object(body) || typeof body.envelope !== "string") throw new Error("Missing assertion");
      value = await openEnvelope(this.signingKey, prefix, body.envelope, this.previousSigningKey);
    } catch { return Response.json({ error: "acquisition_forbidden" }, { status: 403 }); }
    if (!object(value) || !text(value.owner) || typeof value.operation !== "string" || !value.operation
      || typeof value.at !== "number" || typeof value.expiresAt !== "number"
      || !Number.isFinite(value.at) || !Number.isFinite(value.expiresAt)
      || value.at > this.now() + 5_000 || value.expiresAt <= this.now()
      || value.expiresAt <= value.at || value.expiresAt - value.at > 30_000 || value.operation.length > 255)
      return Response.json({ error: "acquisition_forbidden" }, { status: 403 });

    try {
      const attempts = await this.storage.get<Record<string, Attempt>>(storageKey) ?? {};
      const owner = String(value.owner);
      if (value.action === "remove") {
        const ref = text(value.reference);
        if (!ref) return unavailable();
        // This action comes only from the host's authorized saved-binding retirement.
        await this.remove(ref, request.signal);
        return this.reply(null);
      }
      if (value.action === "start") {
        const provider = text(value.provider);
        if (!provider || !providers.some((entry) => entry.id === provider)) return unavailable();
        const prior = Object.values(attempts).find((entry) => entry.owner === owner && entry.operation === value.operation);
        if (prior) return prior.provider === provider && prior.started ? this.reply(prior.started) : unavailable();
        for (const [id, entry] of Object.entries(attempts))
          if (entry.settled && entry.expires <= this.now()) delete attempts[id];
        if (Object.keys(attempts).length >= 200 || Object.values(attempts).filter((entry) => !entry.result || !entry.settled).length >= 16) return unavailable();
        const session = crypto.randomUUID();
        const before = rows((await this.home.data("/credentials", { signal: request.signal })).files)
          .flatMap((row) => text(row.id) ?? []);
        const attempt: Attempt = {
          owner, provider, operation: String(value.operation), expires: this.now() + ttl,
          marker: await this.attribution.begin(), before,
          ...(text(value.reconnect) ? { reconnect: String(value.reconnect) } : {}),
        };
        attempts[session] = attempt;
        // An uncertain start is retained and refused; repeating it could create another credential.
        await this.storage.put(storageKey, attempts);
        await this.arm();
        const started = await this.home.data(`/oauth/auth-url?provider=${encodeURIComponent(provider)}`, { signal: request.signal });
        if (!text(started.state) || !text(started.url)) return unavailable();
        attempt.state = String(started.state);
        const callback = started.flow === "device" ? false
          : started.flow === "browser" || started.flow === "callback" || callbackOrigin(String(started.url)) !== null;
        const code = text(started.user_code) ?? (object(started.meta) ? text(started.meta.user_code) : null);
        attempt.started = {
          session, url: String(started.url), expiresAt: attempt.expires,
          ...(code ? { code } : {}), ...(callback ? { paste: { label: "Callback URL" } } : {}),
        };
        await this.storage.put(storageKey, attempts);
        return this.reply(attempt.started);
      }
      const session = text(value.session);
      const attempt = session ? attempts[session] : undefined;
      if (!attempt || attempt.owner !== owner || attempt.provider !== value.provider || !attempt.state) return unavailable();
      if (value.action === "cancel") {
        if (attempt.result?.state === "connected") {
          const refs = homeReferences(attempt.result.ref);
          // The SDK calls cancel after a failed save. Reconnecting a saved ref never revokes it.
          const fresh = refs.filter((ref) => !attempt.before.includes(ref));
          if (fresh.length) {
            const membership = await this.home.allMembership(request.signal);
            if (membership.members.some((member) => fresh.includes(member.auth_id))) return unavailable();
            await this.remove(homeReference(fresh), request.signal);
          }
          attempt.result = { state: "failed", message: "Sign-in cancelled." };
        } else if (!attempt.result) {
          const cancelled = await this.home.data(`/oauth/session?state=${encodeURIComponent(attempt.state)}`, { method: "DELETE", signal: request.signal });
          if (cancelled.cancelled !== true) {
            await this.progress(attempt, attempts, request.signal);
            // A completed attempt now has a retained ref; the next cancel can release it safely.
            return unavailable();
          }
          attempt.result = { state: "failed", message: "Sign-in cancelled." };
        }
        await this.finish(attempt, attempts, request.signal);
        return this.reply(null);
      }
      if (attempt.result) { await this.finish(attempt, attempts, request.signal); return this.reply(attempt.result); }
      if (value.action === "submit") {
        if (!attempt.started?.paste || typeof value.value !== "string") return unavailable();
        const callback = new URL(value.value);
        if (callback.searchParams.get("state") !== attempt.state) return unavailable();
        await this.home.data("/oauth/callback", { ...post({ provider: attempt.provider, redirect_url: value.value }), signal: request.signal });
      } else if (value.action !== "status") return unavailable();
      await this.progress(attempt, attempts, request.signal);
      return this.reply(attempt.result ?? { state: "waiting" });
    } catch { return Response.json({ error: "acquisition_unavailable" }, { status: 503 }); }
  }

  /** Capture Home's short-lived final answer even when the connection page is closed. */
  async tick(): Promise<void> {
    const attempts = await this.storage.get<Record<string, Attempt>>(storageKey) ?? {};
    for (const attempt of Object.values(attempts)) {
      if (attempt.result && attempt.settled) continue;
      try { await this.progress(attempt, attempts, AbortSignal.timeout(1_000)); }
      catch { /* Retain the attempt and attribution marker for the next alarm. */ }
    }
    if (Object.values(attempts).some((entry) => !entry.result || !entry.settled)) await this.arm();
  }

  async keepAlive(): Promise<void> {
    const attempts = await this.storage.get<Record<string, Attempt>>(storageKey) ?? {};
    if (Object.values(attempts).some((entry) => !entry.result || !entry.settled)) await this.arm();
  }

  private async progress(attempt: Attempt, attempts: Record<string, Attempt>, signal?: AbortSignal): Promise<void> {
    if (attempt.result) return this.finish(attempt, attempts, signal);
    if (attempt.expires <= this.now()) {
      // An unknown start is never repeated or assigned by a directory diff.
      attempt.observed = await this.currentProviderIds(attempt.provider, signal);
      attempt.result = { state: "failed", message: "Sign-in expired before its account could be confirmed. Start again." };
    } else if (attempt.state) {
      const status = await this.home.data(`/oauth/status?state=${encodeURIComponent(attempt.state)}`, { signal });
      if (status.status === "wait") return;
      if (status.status === "error") {
        attempt.result = { state: "failed", message: "The provider sign-in failed or expired." };
      } else if (status.status === "ok") {
        const ids = [...new Set([
          ...(Array.isArray(status.auth_ids) ? status.auth_ids.filter((id): id is string => typeof id === "string" && id.length > 0) : []),
          ...(text(status.auth_id) ? [String(status.auth_id)] : []),
        ])];
        // A directory diff cannot establish which global account this attempt acquired.
        if (ids.length === 0 || ids.length > 32) {
          attempt.result = { state: "failed", message: "The sign-in did not return its exact credentials. No account was linked." };
          return this.finish(attempt, attempts, signal);
        }
        attempt.observed = ids;
        const reconnect = attempt.reconnect === undefined ? [] : homeReferences(attempt.reconnect);
        if (ids.some((id) => attempt.before.includes(id) && !reconnect.includes(id))) {
          attempt.result = { state: "failed", message: "This sign-in returned an existing account. Select its saved account instead." };
          return this.finish(attempt, attempts, signal);
        }
        const credentials = rows((await this.home.data("/credentials", { signal })).files);
        if (!ids.every((id) => credentials.some((row) => row.id === id && (text(row.provider) ?? text(row.type)) === attempt.provider))) return unavailable();
        attempt.result = { state: "connected", ref: homeReference(ids) };
      } else return unavailable();
    }
    if (attempt.result) await this.finish(attempt, attempts, signal);
  }

  private async finish(attempt: Attempt, attempts: Record<string, Attempt>, signal?: AbortSignal): Promise<void> {
    if (!attempt.settled && attempt.result?.state === "failed" && attempt.observed === undefined) {
      // A credential can outlive its final status. Exclude its provider's IDs before releasing a legacy diff.
      attempt.observed = await this.currentProviderIds(attempt.provider, signal);
    }
    // Retain the exact outcome before releasing the legacy attribution exclusion.
    await this.storage.put(storageKey, attempts);
    if (attempt.settled) return;
    await this.attribution.settle(attempt.marker, attempt.observed ?? []);
    attempt.settled = true;
    await this.storage.put(storageKey, attempts);
  }

  private async currentProviderIds(provider: string, signal?: AbortSignal): Promise<string[]> {
    return rows((await this.home.data("/credentials", { signal })).files).flatMap((row) => {
      const id = text(row.id);
      return id && (text(row.provider) ?? text(row.type)) === provider ? [id] : [];
    });
  }

  private async arm(): Promise<void> {
    const next = this.now() + 30_000;
    const alarm = await this.storage.getAlarm();
    if (alarm === null || alarm > next) await this.storage.setAlarm(next);
  }

  private async remove(ref: string, signal?: AbortSignal): Promise<void> {
    const refs = homeReferences(ref);
    for (const id of refs) {
      const response = await this.home.response(`/credentials?id=${encodeURIComponent(id)}`, { method: "DELETE", signal });
      await response.body?.cancel();
      if (!response.ok && response.status !== 404) return unavailable();
    }
    for (const member of (await this.home.allMembership(signal)).members.filter((member) => refs.includes(member.auth_id))) {
      const removed = await this.home.response(`/channel-group-details/${member.id}`, { method: "DELETE", signal });
      await removed.body?.cancel();
      if (!removed.ok && removed.status !== 404) return unavailable();
    }
  }

  private reply(value: unknown): Response {
    return Response.json(value, { headers: { "Cache-Control": "no-store" } });
  }
}
