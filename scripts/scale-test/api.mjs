import { database, prefix, worker } from "./settings.ts";

function controlSignal() {
  const remaining = Number(process.env.SCALE_CONTROL_END_AT ?? Infinity) - Date.now();
  if (remaining <= 0) throw new Error("Control-plane time reserve exhausted");
  return AbortSignal.timeout(Math.min(30_000, remaining));
}
function refusal(path, method, status, data) {
  const collection = ["containers/applications", "workers/durable_objects/namespaces", "workers/scripts",
    "workers/subdomain", "hyperdrive/configs", "mtls_certificates"].find(name =>
    path === name || path.startsWith(`${name}/`) || path.startsWith(`${name}?`)) ?? "request";
  const operation = collection + (path.endsWith("/rollouts") ? "/rollouts" : "");
  const errors = Array.isArray(data?.errors) ? data.errors.slice(0, 20) : [];
  const codes = [...new Set(errors.map(error => error?.code).filter(Number.isSafeInteger))];
  // Only known schema field names survive; remote messages and arbitrary pointers may contain secrets.
  const fields = ["description", "strategy", "target_configuration", "instance_type", "step_percentage", "image", "max_instances"]
    .filter(field => errors.some(error => typeof error?.message === "string"
      && new RegExp(`\\b${field}\\b`).test(error.message)));
  const error = new Error(`Cloudflare ${method} ${operation} failed (${status})`);
  error.diagnostic = { provider: "cloudflare", operation, method, status, codes, fields };
  return error;
}
export async function cf(path, method = "GET", body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controlSignal(),
  });
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) {
    let data;
    // Refusals are small JSON envelopes. Cancel unbounded bodies rather than retaining provider output.
    const reader = response.body?.getReader();
    let bytes = 0; const chunks = [];
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); break; }
        bytes += value.byteLength;
        if (bytes > 65536) { await reader.cancel(); break; }
        chunks.push(Buffer.from(value));
      }
    } catch { /* Diagnostics must not hide the original refusal. */ }
    throw refusal(path, method, response.status, data);
  }
  const data = await response.json();
  if (data.success === false) throw refusal(path, method, response.status, data);
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
    method, headers: { Authorization: `${process.env.PLANETSCALE_API_TOKEN_ID}:${process.env.PLANETSCALE_API_TOKEN}` }, signal: controlSignal(),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PlanetScale ${method} failed (${response.status})`);
  return method === "DELETE" ? true : response.json();
}
const owned = (name) => typeof name === "string" && name.startsWith(`${prefix}-`);
export function publicInventory(resources) {
  return Object.fromEntries(Object.entries(resources).map(([kind, rows]) => [kind, {
    count: rows.length, names: rows.map((row) => row.name ?? row.title ?? (kind === "scripts" ? row.id : "unnamed")),
  }]));
}
export async function inventory() {
  const [applications, namespaces, scripts, drives, certificates, cluster] = await Promise.all([
    list("containers/applications"), list("workers/durable_objects/namespaces"), list("workers/scripts"),
    // The isolated stack uses runner-local state and declares no KV namespace.
    list("hyperdrive/configs"), list("mtls_certificates"), pg(),
  ]);
  return {
    applications: applications.filter((row) => owned(row.name)),
    namespaces: namespaces.filter((row) => row.script === worker || owned(row.name)),
    scripts: scripts.filter((row) => owned(row.id)),
    drives: drives.filter((row) => owned(row.name)),
    certificates: certificates.filter((row) => owned(row.name)),
    database: cluster ? [{ name: database }] : [],
  };
}
export function assertAbsent(resources) {
  if (Object.values(resources).some((rows) => rows.length)) throw new Error("Scale resources remain; inspect teardown artifact");
}
