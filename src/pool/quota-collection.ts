import type { HomeClient } from "./control.ts";
import { digest } from "./backend-users.ts";
import { ControlFailure, object, post, unavailable, type Json } from "./json.ts";

interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
interface Options {
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}
export const quotaCollectInterval = 30 * 60_000;
const checkBudget = 9_000;
const instant = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
export const collectionOf = (value: Json): Json => object(value.collection) ? value.collection
  : object(value.credential) ? value.credential : value;
const statusOf = (value: Json) => value.status ?? value.collection_status;

export function needsQuotaCollection(value: Json, now: number): boolean {
  const collection = collectionOf(value);
  const observed = instant(collection.observed_at);
  return !["success", "partial"].includes(String(statusOf(collection))) || collection.freshness !== "fresh"
    || !Number.isFinite(observed) || observed > now || now - observed >= quotaCollectInterval;
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Quota reads bypass Home's activity gate. The persisted cap survives DO restarts and uncertain POSTs. */
export class QuotaCollection {
  private storage: Storage;
  private client: HomeClient;
  private now: () => number;
  private wait: NonNullable<Options["wait"]>;
  private pending = new Map<string, { work: Promise<Json | null>; waits: boolean }>();
  constructor(storage: Storage, client: HomeClient, options: Options = {}) {
    this.storage = storage; this.client = client;
    this.now = options.now ?? Date.now; this.wait = options.wait ?? wait;
  }
  read(id: string, callerSignal?: AbortSignal, awaitCompletion = true): Promise<Json | null> {
    const pending = this.pending.get(id);
    if (pending) return awaitCompletion && !pending.waits
      ? pending.work.then(() => this.read(id, callerSignal, true)) : pending.work;
    const work = this.collect(id, callerSignal, awaitCompletion).finally(() => {
      if (this.pending.get(id)?.work === work) this.pending.delete(id);
    });
    this.pending.set(id, { work, waits: awaitCompletion });
    return work;
  }
  private async snapshot(id: string, signal: AbortSignal): Promise<Json | null> {
    try {
      const value = await this.client.data(`/quota/credentials/${encodeURIComponent(id)}`, { signal });
      if (!object(value.credential) || value.credential.credential_id !== id) return unavailable();
      return value;
    } catch (error) {
      if (error instanceof ControlFailure && error.code === "not_found") return null;
      throw error;
    }
  }
  private async collect(id: string, callerSignal: AbortSignal | undefined, awaitCompletion: boolean): Promise<Json | null> {
    const timeout = AbortSignal.timeout(checkBudget);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let value = await this.snapshot(id, signal);
    if (!value || !needsQuotaCollection(value, this.now())) return value;
    const collection = collectionOf(value);
    const previous = instant(collection.last_attempt_at);
    const key = `quota-collect-v1:${await digest(id)}`;
    const requested = await this.storage.get<number>(key);
    const last = Math.max(Number.isFinite(previous) ? previous : -Infinity, requested ?? -Infinity);
    const collecting = statusOf(collection) === "collecting";
    if (!collecting) {
      if (this.now() - last < quotaCollectInterval) {
        const justRequested = requested !== undefined && this.now() - requested < checkBudget
          && (!Number.isFinite(previous) || requested > previous);
        if (!awaitCompletion || !justRequested) return value;
      } else {
        // Persist before sending: a transport failure can leave an accepted job behind.
        await this.storage.put(key, this.now());
        const result = await this.client.data("/quota/collect", { ...post({ credential_ids: [id] }), signal });
        if (typeof result.accepted !== "number" || result.accepted < 0 || !Number.isInteger(result.accepted)) return unavailable();
        this.client.dropQuotaDetail(id);
        if (!awaitCompletion) return value;
      }
    }
    const before = JSON.stringify([collection.observed_at, collection.last_attempt_at, statusOf(collection), collection.error]);
    for (;;) {
      value = await this.snapshot(id, signal);
      if (!value) return null;
      const current = collectionOf(value);
      const after = JSON.stringify([current.observed_at, current.last_attempt_at, statusOf(current), current.error]);
      if (after !== before && statusOf(current) !== "collecting") return value;
      if (!awaitCompletion) return value;
      await this.wait(500, signal);
    }
  }
}
