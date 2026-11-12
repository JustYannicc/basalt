import type { OverviewApiPrice, OverviewPriceTable } from "../../apps/pool/overview-contract.ts";
import type { ComputerStorage } from "./computer-registry.ts";
import type { HomeClient } from "./control.ts";
import { BackendFailure, HomeTransportFailure, post } from "./json.ts";
import { baselinePrices } from "./public-price-baseline.ts";
import { priceAliases, type PriceTarget } from "./price-aliases.ts";
import { overviewPricePreview } from "./overview-price-preview.ts";

const batchSize = 100;
const day = 86_400_000;
const retryMs = 30 * 60_000;
const registryKey = "pool-public-price-targets-v1";
const targetKey = (target: PriceTarget) => JSON.stringify([target.provider, target.model]);
const entryKey = (target: PriceTarget) => `pool-public-price-v1:${targetKey(target)}`;
interface RetainedPrice {
  nextAttemptAt: number;
  prices: readonly OverviewApiPrice[];
  reason?: string;
}

/** Official API prices, independent of Home credits and operator billing multipliers. */
export class OverviewPrices {
  private queue: Promise<unknown> = Promise.resolve();
  private home: HomeClient;
  private storage: ComputerStorage;
  private clock: () => number;
  constructor(home: HomeClient, storage: ComputerStorage, clock = Date.now) {
    this.home = home;
    this.storage = storage;
    this.clock = clock;
  }

  read(targets: readonly PriceTarget[], now = this.clock()): Promise<readonly OverviewApiPrice[]> {
    return this.readTable(targets, now).then((table) => table.prices);
  }

  readTable(targets: readonly PriceTarget[], now = this.clock()): Promise<OverviewPriceTable> {
    const work = this.queue.then(() => this.readPrices(targets, now));
    this.queue = work.catch(() => {});
    return work;
  }

  /** The pool alarm refreshes every previously requested model even when nobody opens a view. */
  async refresh(now = this.clock()): Promise<void> {
    const targets = (await this.storage.get<readonly PriceTarget[]>(registryKey)) ?? [];
    for (let offset = 0; offset < targets.length; offset += batchSize)
      await this.read(targets.slice(offset, offset + batchSize), now);
  }

  private async readPrices(targets: readonly PriceTarget[], now: number) {
    const unique = [...new Map(targets.map((target) => [targetKey(target), target])).values()];
    if (!unique.length || unique.length > batchSize) return { prices: [], issues: [] };
    const tracked = (await this.storage.get<readonly PriceTarget[]>(registryKey)) ?? [];
    const registry = [
      ...new Map([...tracked, ...unique].map((target) => [targetKey(target), target])).values(),
    ];
    // A normal overview has at most 100 pairs; keep alarm work bounded across historical views too.
    if (registry.length <= 1000 && registry.length !== tracked.length)
      await this.storage.put(registryKey, registry);
    const entries = await Promise.all(
      unique.map(async (target) => {
        const saved = await this.storage.get<RetainedPrice>(entryKey(target));
        const floor = baselinePrices(target);
        return {
          target,
          retained: saved?.prices.length
            ? saved
            : {
                nextAttemptAt: saved?.nextAttemptAt ?? 0,
                prices: saved?.reason
                  ? floor.prices.map((price) => ({ ...price, refreshFailed: true }))
                  : floor.prices,
                reason: floor.prices.length ? undefined : (saved?.reason ?? floor.reason),
              },
        };
      }),
    );
    const due = entries.filter((entry) => entry.retained.nextAttemptAt <= now);
    if (due.length) {
      // Persist the attempt before fetching, so a restart cannot turn an outage into a retry loop.
      for (const entry of due) {
        entry.retained = { ...entry.retained, nextAttemptAt: now + retryMs };
        await this.storage.put(entryKey(entry.target), entry.retained);
      }
      const started = this.clock();
      try {
        const wanted = due.map((entry) => entry.target);
        const aliases = priceAliases(wanted);
        const response = await this.home.response("/billing/model-prices/import/preview", {
          ...post({
            source: "models.dev",
            targets: wanted,
            policy: {
              overwrite_mode: "missing",
              default_multiplier: 1,
              include_zero_cost: true,
              ...(aliases.length ? { aliases } : {}),
            },
          }),
          // Home's source fetch alone permits eight seconds; include container and decode time.
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new BackendFailure(response.status);
        const preview: unknown = await response.json();
        if (preview === null || typeof preview !== "object" || Array.isArray(preview))
          throw new Error("Invalid public price snapshot");
        // Home stamps its snapshot after fetching. Validate against completion, never request start.
        const fresh = overviewPricePreview(
          preview as Record<string, unknown>,
          wanted,
          this.clock(),
        );
        for (const entry of due) {
          const prices = fresh.prices.get(targetKey(entry.target));
          const reason = fresh.issues.find(
            (issue) => targetKey(issue) === targetKey(entry.target),
          )?.reason;
          entry.retained = prices
            ? {
                nextAttemptAt: now + day,
                prices: prices.map((price) => ({ ...price, basis: "live" as const })),
              }
            : {
                ...entry.retained,
                prices: entry.retained.prices.map((price) => ({ ...price, refreshFailed: true })),
                reason,
              };
          await this.storage.put(entryKey(entry.target), entry.retained);
        }
      } catch (error) {
        // Keep closed diagnostics only; backend messages and response bodies can contain credentials.
        console.error("POOL_PUBLIC_PRICE_REFRESH_FAILED", {
          phase: "home-preview",
          source: "models.dev",
          errorClass:
            error instanceof BackendFailure
              ? "http"
              : error instanceof HomeTransportFailure
                ? error.errorClass
                : error instanceof DOMException && error.name === "TimeoutError"
                  ? "timeout"
                  : error instanceof SyntaxError
                    ? "decode"
                    : error instanceof Error && error.message === "Invalid public price snapshot"
                      ? "snapshot"
                      : "unknown",
          ...(error instanceof BackendFailure ? { backendStatus: error.backendStatus } : {}),
          elapsedMs: Math.max(0, this.clock() - started),
          lastGoodRetained: due.filter((entry) => entry.retained.prices.length > 0).length,
        });
        for (const entry of due) {
          entry.retained = {
            ...entry.retained,
            prices: entry.retained.prices.map((price) => ({ ...price, refreshFailed: true })),
            reason: entry.retained.prices.length
              ? undefined
              : !baselinePrices(entry.target).reason.startsWith("No public price")
                ? baselinePrices(entry.target).reason
                : `Public price refresh failed; no saved price for ${entry.target.model}.`,
          };
          await this.storage.put(entryKey(entry.target), entry.retained);
        }
      }
    }
    return {
      prices: entries.flatMap((entry) => entry.retained.prices),
      issues: entries.flatMap((entry) =>
        entry.retained.reason && !entry.retained.prices.length
          ? [{ ...entry.target, reason: entry.retained.reason }]
          : [],
      ),
    };
  }
}
