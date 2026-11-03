import providers from "./providers.json" with { type: "json" };
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
const deadline = (signal: AbortSignal | undefined) =>
  signal?.aborted === true && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError";
const stillCollecting = (value: Json | null): Json | null => value === null ? null : {
  ...value, collection: { ...collectionOf(value), status: "collecting" },
};

/** Only native model accounts have a quota reporter; connector credentials never do. */
export function hasUsageLimits(file: Json, value: Json = {}): boolean {
  const provider = file.provider ?? file.type;
  if (provider !== "typesafe" && !providers.some((entry) => entry.id === provider)) return false;
  const credential = object(value.credential) ? value.credential : value;
  const windows = Array.isArray(value.windows) ? value.windows : credential.primary_windows;
  return !Array.isArray(windows) || windows.length === 0
    || windows.some((window) => !object(window) || window.is_unlimited !== true);
}

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
  private pending = new Map<string, { work: Promise<Json | null>; waits: boolean; forced: boolean }>();
  constructor(storage: Storage, client: HomeClient, options: Options = {}) {
    this.storage = storage; this.client = client;
    this.now = options.now ?? Date.now; this.wait = options.wait ?? wait;
  }
  read(id: string, callerSignal?: AbortSignal, awaitCompletion = true, force = false): Promise<Json | null> {
    return this.readWithinBudget(id, callerSignal, awaitCompletion, force, AbortSignal.timeout(checkBudget));
  }
  private readWithinBudget(id: string, callerSignal: AbortSignal | undefined, awaitCompletion: boolean, force: boolean, timeout: AbortSignal): Promise<Json | null> {
    const pending = this.pending.get(id);
    if (pending) return (awaitCompletion && !pending.waits || force && !pending.forced)
      ? pending.work.then((value) => timeout.aborted ? stillCollecting(value)
        : this.readWithinBudget(id, callerSignal, awaitCompletion, force, timeout)) : pending.work;
    const work = this.collect(id, callerSignal, awaitCompletion, force, timeout).finally(() => {
      if (this.pending.get(id)?.work === work) this.pending.delete(id);
    });
    this.pending.set(id, { work, waits: awaitCompletion, forced: force });
    return work;
  }
  refresh(id: string, signal?: AbortSignal): Promise<Json | null> { return this.read(id, signal, true, true); }
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
  private async collect(id: string, callerSignal: AbortSignal | undefined, awaitCompletion: boolean, force: boolean, timeout: AbortSignal): Promise<Json | null> {
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let value: Json | null = null, retained: Json | null = null;
    try {
      value = await this.snapshot(id, signal);
      retained = value;
      if (!force && (!value || !needsQuotaCollection(value, this.now()))) return value;
      const collection = value ? collectionOf(value) : {};
      const credential = value && object(value.credential) ? value.credential : value;
      const windows = value?.windows ?? credential?.primary_windows;
      if (!force && Array.isArray(windows) && windows.length > 0
        && windows.every((window) => object(window) && window.is_unlimited === true)) return value;
      const retryAt = instant(collection.next_probe_at);
      if (Number.isFinite(retryAt) && retryAt > this.now()) return value;
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
    } catch (error) {
      // Home owns the queued job. A local wait deadline, this budget or the caller's own request
      // deadline, does not fail or cancel collection. A caller that went away still throws.
      if ((timeout.aborted && !callerSignal?.aborted) || deadline(callerSignal)) return stillCollecting(retained);
      throw error;
    }
  }
}
