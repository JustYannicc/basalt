import { accountsView, HomeClient, poolGroupPrefix } from "./control.ts";
import { CapacityHistory } from "./capacity/history.ts";
import { capacityOverview } from "./capacity/overview.ts";
import { PoolUsage } from "./pool-usage.ts";
import type { UsageStorage } from "./usage-storage.ts";
import type { Json } from "./json.ts";

class Memory implements UsageStorage {
  private values = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

/** Home's two-slot list omits the short allowance when account and model weekly windows occupy it. */
export function quotaSamplingFixture(
  at: number,
  Usage = PoolUsage,
  options: {
    provider?: string;
    plan?: string;
    windows?: Json[];
  } = {},
) {
  const provider = options.provider ?? "codex";
  const iso = new Date(at).toISOString();
  const window = (id: string, seconds: number, remaining: number, scope = "account") => ({
    id,
    scope,
    scope_id: scope === "account" ? "codex" : "codex_bengalfox",
    label: seconds === 18_000 ? "5 hours" : "Weekly",
    status: "healthy",
    unit: "percentage",
    limit: 100,
    remaining,
    remaining_ratio: remaining / 100,
    window_seconds: seconds,
    observed_at: iso,
    expires_at: new Date(at + 30 * 60_000).toISOString(),
  });
  const short = window("codex-primary", 18_000, 75);
  const weekly = window("codex-secondary", 604_800, 60);
  const spark = window("codex-spark", 604_800, 20, "model");
  const credential = {
    credential_id: "synthetic-codex",
    plan: { name: options.plan ?? "Plus" },
    freshness: "fresh",
    collection_status: "success",
    observed_at: iso,
    primary_windows: options.windows ?? [weekly, spark],
  };
  const detail = {
    credential,
    collection: { status: "success", freshness: "fresh", observed_at: iso },
    windows: options.windows ?? [short, weekly, spark],
  };
  const files = [{ id: credential.credential_id, provider, label: "Synthetic subscription" }];
  const calls: string[] = [];
  const client = new HomeClient(
    async (path) => {
      const route = new URL(path, "http://127.0.0.1").pathname.slice("/v8/management".length);
      calls.push(route);
      if (route === "/channel-groups")
        return Response.json({
          channel_groups: [{ id: 1, channel_name: `${poolGroupPrefix}fixture` }],
        });
      if (route === "/channel-group-details")
        return Response.json({
          channel_group_details: [
            { id: 1, channel_group_id: 1, auth_id: credential.credential_id },
          ],
        });
      if (route === "/capabilities") return Response.json({});
      if (route === "/usage/records") return Response.json({ items: [], total: 0 });
      if (route === "/credentials") return Response.json({ files });
      if (route === "/quota/credentials") return Response.json({ items: [credential] });
      if (route === `/quota/credentials/${credential.credential_id}`) return Response.json(detail);
      throw new Error(`Unexpected synthetic Home request: ${route}`);
    },
    () => at,
  );
  const storage = new Memory();
  const usage = new Usage({
    storage,
    client,
    signingKey: "ab".repeat(32),
    audience: async () => [],
    permissions: async () => ({ canUse: true, canManage: true }),
    now: () => new Date(at),
  });
  const history = new CapacityHistory(storage);
  const view = {
    isOwner: true,
    providers: [
      {
        id: provider,
        name: provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider,
      },
    ],
    subscriptionAccountIds: [credential.credential_id],
    accounts: accountsView(files, [detail], new Set([credential.credential_id])),
  };
  return {
    usage,
    history,
    calls,
    credential,
    detail,
    view,
    capacity: (from: number, to: number) => capacityOverview(history, "fixture", from, to),
  };
}
