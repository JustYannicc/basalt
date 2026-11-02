import { database, prefix, worker } from "./settings.ts";

export async function cf(path, method = "GET") {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cloudflare ${method} failed (${response.status})`);
  const data = await response.json();
  if (data.success === false) throw new Error("Cloudflare rejected the operation");
  return data;
}
export async function list(path) {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const data = await cf(`${path}?page=${page}&per_page=100`);
    if (!Array.isArray(data?.result)) throw new Error("Unrecognized Cloudflare list response");
    rows.push(...data.result);
    if (data.result_info?.total_pages !== undefined) {
      if (page >= data.result_info.total_pages) return rows;
    } else if (data.result.length < 100) return rows;
  }
  throw new Error("Cloudflare inventory exceeded pagination limit");
}
export async function pg(method = "GET") {
  const response = await fetch(`https://api.planetscale.com/v1/organizations/${encodeURIComponent(process.env.PLANETSCALE_ORGANIZATION)}/databases/${database}`, {
    method, headers: { Authorization: `${process.env.PLANETSCALE_API_TOKEN_ID}:${process.env.PLANETSCALE_API_TOKEN}` }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PlanetScale ${method} failed (${response.status})`);
  return method === "DELETE" ? true : response.json();
}
export async function inventory() {
  const [applications, namespaces, scripts, kv, drives, certificates, cluster] = await Promise.all([
    list("containers/applications"), list("workers/durable_objects/namespaces"), list("workers/scripts"),
    list("storage/kv/namespaces"), list("hyperdrive/configs"), list("mtls_certificates"), pg(),
  ]);
  return {
    applications: applications.filter((row) => row.name?.startsWith(prefix)),
    namespaces: namespaces.filter((row) => row.script === worker || row.name?.startsWith(prefix)),
    scripts: scripts.filter((row) => row.id?.startsWith(prefix)),
    kv: kv.filter((row) => row.title?.startsWith(prefix)),
    drives: drives.filter((row) => row.name?.startsWith(prefix)),
    certificates: certificates.filter((row) => row.name?.startsWith(prefix)),
    database: cluster ? [{ name: database }] : [],
  };
}
export function assertAbsent(resources) {
  if (Object.values(resources).some((rows) => rows.length)) throw new Error("Scale resources remain; inspect teardown artifact");
}
