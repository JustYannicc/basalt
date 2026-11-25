import { stageCloudflare } from "../stage-cloudflare/api.mjs";
import { database, prefix } from "./settings.ts";

function controlSignal() {
  const remaining = Number(process.env.SCALE_CONTROL_END_AT ?? Infinity) - Date.now();
  if (remaining <= 0) throw new Error("Control-plane time reserve exhausted");
  return AbortSignal.timeout(Math.min(30_000, remaining));
}
/** The scale stage's view of the account: everything named basalt-180-scale-*, and nothing else. */
export const account = () =>
  stageCloudflare({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    prefix,
    signal: controlSignal,
  });
export async function pg(method = "GET") {
  const response = await fetch(
    `https://api.planetscale.com/v1/organizations/${encodeURIComponent(process.env.PLANETSCALE_ORGANIZATION)}/databases/${database}`,
    {
      method,
      headers: {
        Authorization: `${process.env.PLANETSCALE_API_TOKEN_ID}:${process.env.PLANETSCALE_API_TOKEN}`,
      },
      signal: controlSignal(),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PlanetScale ${method} failed (${response.status})`);
  return method === "DELETE" ? true : response.json();
}
export function publicInventory(resources) {
  return Object.fromEntries(
    Object.entries(resources).map(([kind, rows]) => [
      kind,
      {
        count: rows.length,
        names: rows.map(
          (row) => row.name ?? row.title ?? (kind === "scripts" ? row.id : "unnamed"),
        ),
      },
    ]),
  );
}
export async function inventory(stage = account()) {
  const [found, cluster] = await Promise.all([
    // The isolated stack uses runner-local state and declares no KV namespace.
    stage.inventory(["applications", "namespaces", "scripts", "drives", "certificates"]),
    pg(),
  ]);
  return { ...found, database: cluster ? [{ name: database }] : [] };
}
export function assertAbsent(resources) {
  if (Object.values(resources).some((rows) => rows.length))
    throw new Error("Scale resources remain; inspect teardown artifact");
}
