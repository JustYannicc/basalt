import { pathToFileURL } from "node:url";
import { deployment } from "../brand.ts";

type Namespace = { namespace: string; jurisdiction: string };
type Repository = { name: string };
type Token = { id: string };
type Page<T> = { result: T[]; result_info?: { cursor?: string } };

export interface ArtifactsApi {
  listNamespaces(cursor?: string): Promise<Page<Namespace>>;
  createNamespace(name: string): Promise<Namespace>;
  deleteNamespace(name: string): Promise<void>;
  listRepositories(namespace: string, cursor?: string): Promise<Page<Repository>>;
  deleteRepository(namespace: string, repository: string): Promise<void>;
  listRepositoryTokens(namespace: string, repository: string, cursor?: string): Promise<Page<Token>>;
  deleteToken(namespace: string, token: string): Promise<void>;
}

export type ArtifactsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function bodyResult<T>(response: Response, operation: string): Promise<T> {
  if (!response.ok) throw new Error(`Cloudflare Artifacts ${operation} failed with HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("result" in body))
    throw new Error(`Cloudflare Artifacts ${operation} returned an invalid response`);
  if ("success" in body && body.success !== true)
    throw new Error(`Cloudflare Artifacts ${operation} was rejected`);
  return body.result as T;
}

/** Cloudflare Artifacts API; responses and errors never include credentials or hostnames. */
export function cloudflareArtifactsApi(
  account: string,
  token: string,
  fetcher: ArtifactsFetch = fetch,
): ArtifactsApi {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/artifacts`;
  const request = (url: string, method: string, body?: unknown) =>
    fetcher(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async <T>(url: string, cursor?: string) => {
    const target = new URL(url);
    target.searchParams.set("limit", "200");
    if (cursor) target.searchParams.set("cursor", cursor);
    return bodyResult<Page<T>>(await request(target, "GET"), "list");
  };
  return {
    listNamespaces: (cursor) => list(`${base}/namespaces`, cursor),
    createNamespace: async (name) => {
      const response = await request(`${base}/namespaces`, "POST", { namespace: name, jurisdiction: "eu" });
      const result = await bodyResult<Namespace>(response, "namespace creation");
      if (typeof result?.namespace !== "string" || typeof result.jurisdiction !== "string")
        throw new Error("Cloudflare Artifacts namespace creation returned invalid attributes");
      return result;
    },
    deleteNamespace: async (name) => {
      const response = await request(`${base}/namespaces/${encodeURIComponent(name)}`, "DELETE");
      if (response.status === 404 || response.status === 204) return;
      if (!response.ok)
        throw new Error(`Cloudflare Artifacts namespace deletion failed with HTTP ${response.status}`);
    },
    listRepositories: (namespace, cursor) =>
      list(`${base}/namespaces/${encodeURIComponent(namespace)}/repos`, cursor),
    deleteRepository: async (namespace, repository) => {
      const response = await request(
        `${base}/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repository)}`,
        "DELETE",
      );
      if ([202, 204, 404].includes(response.status)) return;
      if (!response.ok)
        throw new Error(`Cloudflare Artifacts repository deletion failed with HTTP ${response.status}`);
    },
    listRepositoryTokens: (namespace, repository, cursor) =>
      list(
        `${base}/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repository)}/tokens`,
        cursor,
      ),
    deleteToken: async (namespace, tokenId) => {
      const response = await request(
        `${base}/namespaces/${encodeURIComponent(namespace)}/tokens/${encodeURIComponent(tokenId)}`,
        "DELETE",
      );
      if ([202, 204, 404].includes(response.status)) return;
      if (!response.ok)
        throw new Error(`Cloudflare Artifacts token deletion failed with HTTP ${response.status}`);
    },
  };
}

async function allPages<T>(read: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const results: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    if (!Array.isArray(page?.result)) throw new Error("Invalid Cloudflare Artifacts list response");
    results.push(...page.result);
    const next = page.result_info?.cursor || undefined;
    if (next && seen.has(next)) throw new Error("Cloudflare Artifacts pagination repeated a cursor");
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return results;
}

const hasNamespace = async (api: ArtifactsApi, name: string) =>
  (await allPages((cursor) => api.listNamespaces(cursor))).find((item) => item.namespace === name);

/** Every page is inspected before creating a namespace with immutable EU jurisdiction. */
export async function ensureEuNamespace(api: ArtifactsApi, name: string): Promise<void> {
  let namespace = await hasNamespace(api, name);
  if (!namespace) namespace = await api.createNamespace(name);
  if (namespace.namespace !== name || namespace.jurisdiction !== "eu")
    throw new Error("Artifacts namespace must have immutable EU jurisdiction; deployment stopped");
}

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Delete the per-stage repositories before its namespace and read back both absences. */
export async function deleteEuNamespace(
  api: ArtifactsApi,
  name: string,
  options: { readonly attempts?: number; readonly delayMs?: number; readonly wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = options.attempts ?? 30;
  const delay = options.delayMs ?? 1000;
  const wait = options.wait ?? pause;
  const namespace = await hasNamespace(api, name);
  if (!namespace) return;
  if (namespace.namespace !== name)
    throw new Error("Refusing to delete an unexpected Artifacts namespace");

  const repositories = await allPages((cursor) => api.listRepositories(name, cursor));
  for (const repository of repositories) {
    if (!repository.name) throw new Error("Invalid Artifacts repository list response");
    const tokens = await allPages((cursor) => api.listRepositoryTokens(name, repository.name, cursor));
    for (const token of tokens) {
      if (!token.id) throw new Error("Invalid Artifacts token list response");
      await api.deleteToken(name, token.id);
    }
    await api.deleteRepository(name, repository.name);
  }
  let empty = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await allPages((cursor) => api.listRepositories(name, cursor))).length === 0) {
      empty = true;
      break;
    }
    await wait(delay);
  }
  if (!empty) throw new Error("Artifacts repositories are still present after deletion");

  await api.deleteNamespace(name);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!(await hasNamespace(api, name))) return;
    await wait(delay);
  }
  throw new Error("Artifacts namespace is still present after deletion");
}

async function main(): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Missing Cloudflare deploy credentials");
  const namespace = process.env.CLOUD_SOURCE_NAMESPACE ?? deployment.sourceNamespace;
  await ensureEuNamespace(cloudflareArtifactsApi(account, token), namespace);
  console.log("Artifacts namespace uses EU jurisdiction");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
