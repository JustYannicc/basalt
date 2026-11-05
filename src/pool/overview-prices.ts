import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import type { HomeClient } from "./control.ts";
import { object, post, rows, text } from "./json.ts";

const maxTargets = 100;
const cacheMs = 30 * 60_000;
function priceNumber(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1e9)
    return null;
  const decimal = value.toFixed(12).replace(/\.?0+$/, "");
  // Preserve the ledger's twelve decimal places without converting a tiny positive price to free.
  return value > 0 && Number(decimal) === 0 ? null : decimal || "0";
}

/** Current official API prices, independent of Home credits or an operator's billing multiplier. */
export class OverviewPrices {
  private home: HomeClient;
  private cached?: { key: string; at: number; prices: readonly OverviewApiPrice[] };
  private reading?: { key: string; work: Promise<readonly OverviewApiPrice[]> };
  constructor(home: HomeClient) {
    this.home = home;
  }

  read(
    targets: readonly { provider: string; model: string }[],
    now = Date.now(),
  ): Promise<readonly OverviewApiPrice[]> {
    const unique = [
      ...new Map(
        targets.map((target) => [JSON.stringify([target.provider, target.model]), target]),
      ).values(),
    ].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
    if (!unique.length || unique.length > maxTargets) return Promise.resolve([]);
    const key = JSON.stringify(unique);
    if (this.cached?.key === key && now - this.cached.at < cacheMs)
      return Promise.resolve(this.cached.prices);
    if (this.reading?.key === key) return this.reading.work;
    const work = this.loadPrices(unique, now)
      .then((prices) => {
        this.cached = { key, at: now, prices };
        return prices;
      })
      .catch(() => [] as readonly OverviewApiPrice[])
      .finally(() => {
        if (this.reading?.work === work) this.reading = undefined;
      });
    this.reading = { key, work };
    return work;
  }

  private async loadPrices(
    targets: readonly { provider: string; model: string }[],
    now: number,
  ): Promise<readonly OverviewApiPrice[]> {
    // Home pins the catalog snapshot and validates the whole model's context bands. Preview never
    // changes billing rules. Only `official` is used, even when an existing manual rule differs.
    const preview = await this.home.data("/billing/model-prices/import/preview", {
      ...post({
        source: "models.dev",
        targets,
        policy: { overwrite_mode: "missing", default_multiplier: 1, include_zero_cost: true },
      }),
      signal: AbortSignal.timeout(4_000),
    });
    const version = text(preview.source_version),
      asOf = text(preview.source_fetched_at);
    if (
      preview.source !== "models.dev" ||
      preview.atomic !== true ||
      !version ||
      !asOf ||
      !Number.isFinite(Date.parse(asOf)) ||
      Date.parse(asOf) > now ||
      now - Date.parse(asOf) > 86_400_000
    )
      return [];
    const wanted = new Set(
      targets.map((target) => JSON.stringify([target.provider, target.model])),
    );
    const all = rows(preview.rows);
    const invalid = new Set(
      all
        .filter((row) => !["matched", "zero_cost"].includes(text(row.status) ?? ""))
        .map((row) => JSON.stringify([row.provider, row.model])),
    );
    const result: OverviewApiPrice[] = [];
    for (const row of all) {
      const key = JSON.stringify([row.provider, row.model]);
      if (
        !wanted.has(key) ||
        invalid.has(key) ||
        !object(row.official) ||
        row.service_tier !== "*" ||
        typeof row.min_input_tokens !== "number" ||
        !Number.isSafeInteger(row.min_input_tokens) ||
        row.min_input_tokens < 0
      )
        continue;
      const official = row.official;
      const input = priceNumber(official.input),
        output = priceNumber(official.output),
        cacheRead = priceNumber(official.cache_read),
        cacheWrite = priceNumber(official.cache_write),
        request = priceNumber(official.request);
      if (
        input === null ||
        output === null ||
        cacheRead === null ||
        cacheWrite === null ||
        request === null
      )
        continue;
      result.push({
        provider: String(row.provider),
        model: String(row.model),
        currency: "USD",
        input,
        output,
        cacheRead,
        cacheWrite,
        request,
        tier: "*",
        minInput: String(row.min_input_tokens),
        asOf,
        source: "models.dev",
        version,
      });
    }
    return result;
  }
}
