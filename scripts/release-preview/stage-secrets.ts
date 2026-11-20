/**
 * Read-only (coordinator 17:14Z 20 Nov): the account's Secrets Stores and, per store, the names of
 * its secrets. Never a value: the list endpoints return metadata only, and only names are kept.
 * Names go to the stage's private output; the public summary carries counts.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type Store = { id?: unknown; name?: unknown };
type Secret = { name?: unknown };

/** Only the fields that answer the question: store names, secret names, nothing else. */
export function secretsInventory(
  stores: readonly Store[],
  secretsByStore: ReadonlyMap<string, readonly Secret[]>,
  stage: string,
) {
  const rows = stores.map((store) => {
    const id = typeof store.id === "string" ? store.id : "";
    const names = (secretsByStore.get(id) ?? [])
      .map((secret) => (typeof secret.name === "string" ? secret.name : ""))
      .filter(Boolean)
      .sort();
    return {
      store: typeof store.name === "string" ? store.name : "(unnamed)",
      secrets: names,
      productionObservation: names.includes("basalt-production-pool-provider-observation"),
      stageObservation: names.includes(`basalt-${stage}-pool-provider-observation`),
    };
  });
  return {
    stores: rows.length,
    secrets: rows.reduce((total, row) => total + row.secrets.length, 0),
    rows,
  };
}

export async function readSecretsStores(source: NodeJS.ProcessEnv, outputs: string, stage: string) {
  const account = encodeURIComponent(source.CLOUDFLARE_ACCOUNT_ID ?? "");
  const headers = { Authorization: `Bearer ${source.CLOUDFLARE_API_TOKEN ?? ""}` };
  const list = async (path: string) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}${path}?per_page=100`,
      { headers },
    );
    if (!response.ok)
      throw new Error(`The Secrets Store list refused with HTTP ${response.status}`);
    const body = (await response.json()) as {
      result?: unknown[];
      result_info?: { total_count?: number };
    };
    return {
      items: (body.result ?? []) as Record<string, unknown>[],
      total: body.result_info?.total_count,
    };
  };
  const stores = await list("/secrets_store/stores");
  const secretsByStore = new Map<string, Secret[]>();
  const truncated: string[] = [];
  for (const store of stores.items) {
    if (typeof store.id !== "string") continue;
    const secrets = await list(`/secrets_store/stores/${encodeURIComponent(store.id)}/secrets`);
    secretsByStore.set(store.id, secrets.items);
    if ((secrets.total ?? 0) > secrets.items.length) truncated.push(String(store.name ?? store.id));
  }
  const inventory = secretsInventory(stores.items, secretsByStore, stage);
  await writeFile(
    join(outputs, "secrets-stores.json"),
    `${JSON.stringify({ ...inventory, truncated }, null, 2)}\n`,
    { mode: 0o600 },
  );
  // Public: counts only.
  return { stores: inventory.stores, secrets: inventory.secrets, truncated: truncated.length };
}
