import { cloudflareApi, ownedBy, ownedWorkers, workerListings } from "../stage-cloudflare/api.mjs";
import { database, prefix, worker } from "./settings.ts";

function controlSignal() {
  const remaining = Number(process.env.SCALE_CONTROL_END_AT ?? Infinity) - Date.now();
  if (remaining <= 0) throw new Error("Control-plane time reserve exhausted");
  return AbortSignal.timeout(Math.min(30_000, remaining));
}
const account = () =>
  cloudflareApi({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    signal: controlSignal,
  });
// The scale test has always read a missing resource as null; every other refusal throws.
export const cf = (path, method = "GET", body) =>
  method === "GET" ? account().find(path) : account().cf(path, method, body);
export const list = (path) => account().list(path);
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
const owned = ownedBy(prefix);
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
export async function inventory() {
  const [applications, namespaces, scripts, drives, certificates, cluster] = await Promise.all([
    ...workerListings(list),
    // The isolated stack uses runner-local state and declares no KV namespace.
    list("hyperdrive/configs"),
    list("mtls_certificates"),
    pg(),
  ]);
  return {
    ...ownedWorkers(
      [applications, namespaces, scripts],
      owned,
      (row) => row.script === worker || owned(row.name),
    ),
    drives: drives.filter((row) => owned(row.name)),
    certificates: certificates.filter((row) => owned(row.name)),
    database: cluster ? [{ name: database }] : [],
  };
}
export function assertAbsent(resources) {
  if (Object.values(resources).some((rows) => rows.length))
    throw new Error("Scale resources remain; inspect teardown artifact");
}
