import providers from "./providers.json" with { type: "json" };
import type { ComputerStorage } from "./computer-registry.ts";
import type { HomeClient } from "./control.ts";
import { object, post, rows, text, unavailable } from "./json.ts";

const day = 24 * 60 * 60_000;
const check = 30 * 60_000;
const stateKey = "pool-price-upkeep-v1";
const allowedProviders = new Set(providers.map((provider) => provider.id));

// Home v1.1.6 internal/cluster/billing.go:1460-1463 defaults to request tiers and UTC.
// :734-752 creates charges even for unlimited users; :901-902 only skips balance deductions.
/** Alarm-only. Home owns catalog matching, source fetching and transactional conflict checks. */
export class PriceUpkeep {
  private home: HomeClient;
  private storage: ComputerStorage;
  private running?: Promise<void>;
  private checkedAt = -Infinity;
  constructor(home: HomeClient, storage: ComputerStorage) { this.home = home; this.storage = storage; }
  run(now = Date.now()): Promise<void> {
    this.running ??= this.update(now).catch((error: unknown) => {
      console.error("Pool price upkeep failed; retrying on the next daily attempt", error);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async update(now: number): Promise<void> {
    // A new model waits at most this long for its price; the model list isn't read every alarm.
    if (now - this.checkedAt < check) return;
    this.checkedAt = now;
    // Home v1.1.6 management/model_definitions.go:96-172 exposes actual Billing identities.
    const models = rows((await this.home.data("/models?scope=available")).models);
    const targets = new Map<string, { provider: string; model: string }>();
    for (const model of models) {
      const identities = Array.isArray(model.billing_models) ? rows(model.billing_models)
        : Array.isArray(model.providers) && text(model.id) ? model.providers.map((provider) => ({ provider, model: model.id })) : [];
      for (const identity of identities) {
        if (typeof identity.provider !== "string" || !allowedProviders.has(identity.provider) || !text(identity.model)) continue;
        targets.set(JSON.stringify([identity.provider, identity.model]), { provider: identity.provider, model: String(identity.model) });
      }
    }
    // A model someone priced by hand stays theirs: an imported context band would win for long
    // requests (Home picks the highest min_input_tokens band, docs/management/api.md GET model-prices).
    const manual = new Set(rows((await this.home.data("/billing/model-prices")).items)
      .filter((rule) => rule.source !== "sync").map((rule) => JSON.stringify([rule.provider, rule.model])));
    for (const key of manual) targets.delete(key);
    if (!targets.size) return;
    // Charges are priced when a request happens, so a newly connected model can't wait a day.
    const known = JSON.stringify([...targets.keys()].sort());
    const attempted = await this.storage.get<{ at: number; models: string }>(stateKey);
    if (attempted && attempted.models === known && now - attempted.at < day) return;
    // Persist before the remote call so failures and DO restarts cannot hammer models.dev.
    await this.storage.put(stateKey, { at: now, models: known });
    // Home v1.1.6 internal/cluster/billing_import.go:917-950 maps model names to source providers.
    // :658-687 imports wildcard base/context bands; sync skips manual rules.
    // Exact service-tier rules remain manual. No provider aliases here.
    const preview = await this.home.data("/billing/model-prices/import/preview", post({
      source: "models.dev", targets: [...targets.values()],
      policy: { overwrite_mode: "sync", default_multiplier: 1, include_zero_cost: true },
    }));
    if (!text(preview.preview_id) || !text(preview.preview_revision) || preview.atomic !== true) return unavailable();
    const selected = rows(preview.rows).filter((row) => row.applicable === true
      && (row.action === "create" || row.action === "update_sync")
      && (!object(row.existing_rule) || row.existing_rule.source === "sync"));
    const skipped = rows(preview.rows).filter((row) => row.action !== "skip" && row.applicable !== true);
    if (skipped.length) console.error("Pool models have no importable API-equivalent price", skipped.map((row) =>
      ({ provider: row.provider, model: row.model, status: row.status })));
    if (!selected.length) return;
    if (selected.some((row) => !text(row.row_key))) return unavailable();
    // Home v1.1.6 internal/cluster/management/billing_import.go:55-89: pinned revisions,
    // 409 on concurrent edits, 410 expiry, 412 stale preview. Retry with a fresh daily preview.
    const result = await this.home.data("/billing/model-prices/import/apply", post({
      preview_id: preview.preview_id, preview_revision: preview.preview_revision,
      selected_keys: selected.map((row) => row.row_key), confirm_overwrite: false,
      idempotency_key: `signalbox-prices-${preview.preview_id}`,
    }));
    if (result.status !== "applied" || result.atomic !== true) return unavailable();
  }
}
