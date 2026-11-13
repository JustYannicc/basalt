import type { PlanAllowanceCatalog } from "../../../.upstream/packages/apps/src/contracts/account-plan-allowance.ts";
import type { ComputerStorage } from "../computer-registry.ts";
import { digest } from "../backend-users.ts";
import {
  allowanceKey,
  datasetUrl,
  dayMs,
  seedCatalog,
  sourceMaxAge,
  type PlanAllowance,
} from "./data.ts";
import { datasetAllowances } from "./dataset.ts";
import { vendorAllowances, vendorSources, type VendorSourceId } from "./vendors.ts";

const stateKey = "pool-plan-allowances-v1";
const retryMs = 30 * 60_000;
interface SourceState {
  at: number;
  nextAttemptAt: number;
  hash: string | null;
  state: "checked" | "changed" | "unavailable";
  entries: readonly PlanAllowance[];
}
interface State {
  nextAttemptAt: number;
  sources: Record<string, SourceState>;
}

async function publicSource(fetcher: typeof fetch, url: string): Promise<string> {
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
    headers: { accept: "application/json, text/plain, text/html" },
  });
  if (!response.ok || !response.body) throw new Error("Allowance source unavailable");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_048_576) throw new Error("Allowance source too large");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(joined);
}

/** One persisted daily source refresh serves every pool; failed fetches never renew a value's age. */
export class PlanAllowances {
  private running?: Promise<void>;
  private storage: ComputerStorage;
  private fetcher: typeof fetch;
  private now: () => number;
  private seed: PlanAllowanceCatalog;
  constructor(
    storage: ComputerStorage,
    options: { fetch?: typeof fetch; now?: () => number; seed?: PlanAllowanceCatalog } = {},
  ) {
    this.storage = storage;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? seedCatalog;
  }
  refresh(): Promise<void> {
    this.running ??= this.update().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async update(): Promise<void> {
    const now = this.now();
    const state = (await this.storage.get<State>(stateKey)) ?? { nextAttemptAt: 0, sources: {} };
    if (state.nextAttemptAt > now && state.nextAttemptAt <= now + dayMs) return;
    state.nextAttemptAt = now + retryMs;
    await this.storage.put(stateKey, state);
    const jobs: [string, readonly string[], (bodies: readonly string[]) => PlanAllowance[]][] = [
      ["dataset", [datasetUrl], (bodies) => datasetAllowances(JSON.parse(bodies[0]!), now)],
      ...Object.entries(vendorSources).map(
        ([id, urls]) =>
          [
            id,
            urls,
            (bodies: readonly string[]) => vendorAllowances(id as VendorSourceId, bodies, now),
          ] as [string, readonly string[], (bodies: readonly string[]) => PlanAllowance[]],
      ),
    ];
    await Promise.all(
      jobs.map(async ([id, urls, parse]) => {
        const previous = state.sources[id];
        if (previous && previous.nextAttemptAt > now && previous.nextAttemptAt <= now + dayMs)
          return;
        let bodies: string[];
        try {
          bodies = await Promise.all(urls.map((url) => publicSource(this.fetcher, url)));
        } catch {
          state.sources[id] = {
            at: now,
            nextAttemptAt: now + retryMs,
            hash: previous?.hash ?? null,
            state: "unavailable",
            entries: previous?.entries ?? [],
          };
          return;
        }
        const hash = await digest(JSON.stringify(bodies));
        const old = previous?.entries ?? this.seed.entries.filter((entry) => entry.sourceId === id);
        const revoked = (entry: PlanAllowance): PlanAllowance => ({
          ...entry,
          full: null,
          verification: "unknown",
          contradicted: true,
          checkedAt: now,
          fetchedAt: now,
          expiresAt: now + sourceMaxAge,
          detail: "The source changed or no longer confirms this allowance; sized as one account",
        });
        try {
          const entries = await Promise.all(
            parse(bodies).map(async (entry) => ({
              ...entry,
              sourceId: id,
              revision:
                old.find(
                  (value) =>
                    allowanceKey(value) === allowanceKey(entry) &&
                    value.full === entry.full &&
                    value.unit.id === entry.unit.id &&
                    value.verification === entry.verification &&
                    Boolean(value.unlimited) === Boolean(entry.unlimited),
                )?.revision ??
                `allowance-v1:${await digest(
                  JSON.stringify([
                    entry.vendor,
                    entry.plan,
                    entry.windowSeconds,
                    entry.full,
                    entry.unit.id,
                    entry.verification,
                    entry.unlimited ?? false,
                  ]),
                )}`,
            })),
          );
          const keys = new Set(entries.map(allowanceKey));
          const removed = old.filter((entry) => !keys.has(allowanceKey(entry))).map(revoked);
          state.sources[id] = {
            at: now,
            nextAttemptAt: now + dayMs,
            hash,
            state: previous?.hash && previous.hash !== hash ? "changed" : "checked",
            entries: [...entries, ...removed],
          };
        } catch {
          state.sources[id] = {
            at: now,
            nextAttemptAt: now + retryMs,
            hash,
            state: "changed",
            entries: old.map(revoked),
          };
        }
      }),
    );
    state.nextAttemptAt = Math.min(
      ...Object.values(state.sources).map((source) => source.nextAttemptAt),
    );
    await this.storage.put(stateKey, state);
  }
  async read(): Promise<PlanAllowanceCatalog> {
    const state = await this.storage.get<State>(stateKey);
    const entries = [
      ...this.seed.entries.filter((entry) => {
        const id = entry.sourceId;
        return !id || !state?.sources[id] || state.sources[id]!.state === "unavailable";
      }),
      ...Object.values(state?.sources ?? {}).flatMap((source) => source.entries),
    ];
    const now = this.now();
    const active = entries.filter(
      (entry) =>
        entry.checkedAt !== null &&
        entry.checkedAt <= now &&
        entry.expiresAt !== null &&
        entry.expiresAt > now,
    );
    const conflicts = new Set<string>();
    for (const entry of active.filter((value) => value.kind === "dataset")) {
      const vendor = active.find(
        (value) => value.kind === "vendor" && allowanceKey(value) === allowanceKey(entry),
      );
      if (
        vendor &&
        (vendor.full !== entry.full || Boolean(vendor.unlimited) !== Boolean(entry.unlimited))
      )
        conflicts.add(allowanceKey(entry));
    }
    return {
      entries: entries.map((entry) =>
        conflicts.has(allowanceKey(entry)) ? { ...entry, contradicted: true } : entry,
      ),
    };
  }
  async status(): Promise<State | undefined> {
    return this.storage.get<State>(stateKey);
  }
}
