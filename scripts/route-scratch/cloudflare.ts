/**
 * The Cloudflare reads and deletes a scratch run needs, by name prefix. Failures carry the operation
 * and HTTP status only: provider bodies can hold account details and never reach a log.
 */
import { gatewayName, prefix, workerName, type Stage } from "./settings.ts";

export class CloudflareRefused extends Error {
  constructor(operation: string, method: string, status: number) {
    super(`Cloudflare ${method} ${operation} failed (${status})`);
    this.name = "CloudflareRefused";
  }
}

export interface Account {
  readonly accountId: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

async function cf(account: Account, path: string, method = "GET") {
  const response = await (account.fetch ?? fetch)(
    `https://api.cloudflare.com/client/v4/accounts/${account.accountId}/${path}`,
    {
      method,
      headers: { Authorization: `Bearer ${account.token}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const operation = path.split(/[/?]/u).slice(0, 2).join("/");
  if (response.status === 404 && method === "GET") {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CloudflareRefused(operation, method, response.status);
  }
  const data = (await response.json()) as { success?: boolean; result?: unknown };
  if (data.success === false) throw new CloudflareRefused(operation, method, response.status);
  return data;
}

async function list(account: Account, path: string) {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 50; page += 1) {
    const data = (await cf(account, `${path}?page=${page}&per_page=100`)) as {
      result?: unknown;
      result_info?: { total_pages?: number };
    } | null;
    if (!Array.isArray(data?.result)) throw new Error(`Unrecognized Cloudflare list for ${path}`);
    rows.push(...(data.result as Array<Record<string, unknown>>));
    const pages = data.result_info?.total_pages;
    if (pages !== undefined ? page >= pages : data.result.length < 100) return rows;
  }
  throw new Error(`Cloudflare list ${path} exceeded the page limit`);
}

/** What this stage owns now: everything it names, and nothing that merely shares a word with it. */
export async function inventory(account: Account, stage: Stage) {
  const owned = (name: unknown) => typeof name === "string" && name.startsWith(`${prefix(stage)}-`);
  const [applications, namespaces, scripts] = await Promise.all([
    list(account, "containers/applications"),
    list(account, "workers/durable_objects/namespaces"),
    list(account, "workers/scripts"),
  ]);
  return {
    applications: applications.filter((row) => owned(row.name)),
    namespaces: namespaces.filter((row) => row.script === workerName(stage) || owned(row.name)),
    scripts: scripts.filter((row) => owned(row.id)),
  };
}
export type Inventory = Awaited<ReturnType<typeof inventory>>;

/** Counts only: names are public by design, ids and hosts are not printed. */
export const counts = (resources: Inventory) =>
  Object.fromEntries(Object.entries(resources).map(([kind, rows]) => [kind, rows.length]));

export const empty = (resources: Inventory) =>
  Object.values(resources).every((rows) => rows.length === 0);

/** The stage's two named resources, both present: the Worker and the gateway application. */
export const deployed = (resources: Inventory, stage: Stage) =>
  resources.scripts.some((row) => row.id === workerName(stage)) &&
  resources.applications.some((row) => row.name === gatewayName(stage));

/** Deletes whatever this stage still owns, by id. A Worker delete also removes its namespaces. */
export async function removeAll(account: Account, resources: Inventory) {
  const failed: string[] = [];
  const remove = async (kind: string, path: string) => {
    try {
      await cf(account, path, "DELETE");
    } catch {
      failed.push(kind);
    }
  };
  for (const app of resources.applications)
    await remove("application", `containers/applications/${String(app.id)}`);
  for (const script of resources.scripts)
    await remove("worker", `workers/scripts/${String(script.id)}?force=true`);
  for (const namespace of resources.namespaces)
    await remove("namespace", `workers/durable_objects/namespaces/${String(namespace.id)}`);
  return failed;
}

/** The account's workers.dev subdomain, from which the stage's origin follows. */
export async function workersOrigin(account: Account, stage: Stage) {
  const data = (await cf(account, "workers/subdomain")) as {
    result?: { subdomain?: string };
  } | null;
  const subdomain = data?.result?.subdomain;
  if (!subdomain || !/^[a-z0-9-]+$/u.test(subdomain)) throw new Error("No workers.dev subdomain");
  const url = new URL("https://workers.dev");
  url.hostname = `${workerName(stage)}.${subdomain}.workers.dev`;
  return url.origin;
}
