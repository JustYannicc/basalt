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
  listRepositoryTokens(
    namespace: string,
    repository: string,
    cursor?: string,
  ): Promise<Page<Token>>;
  deleteToken(namespace: string, token: string): Promise<void>;
}

export type ArtifactsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const failureHeaders = {
  "cf-ray": /^[a-f0-9]{16}(?:-[A-Z]{3})?$/i,
  "cf-mitigated": /^challenge$/,
  "retry-after": /^\d{1,10}$/,
  "x-ratelimit-limit": /^\d{1,10}$/,
  "x-ratelimit-remaining": /^\d{1,10}$/,
  "x-ratelimit-reset": /^\d{1,10}$/,
};

async function failureBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const bytes = new Uint8Array(64 * 1024);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
      // Stop at the ceiling without requesting another chunk just to discover EOF.
      if (value.byteLength >= bytes.byteLength - length) {
        void reader.cancel().catch(() => {});
        return;
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function apiFailure(response: Response, message: string, body?: unknown): Promise<Error> {
  const envelope: unknown = body ?? (await failureBody(response).catch(() => undefined));
  const errors =
    typeof envelope === "object" && envelope !== null && "errors" in envelope
      ? envelope.errors
      : undefined;
  const codes = new Set<number>();
  if (Array.isArray(errors)) {
    for (const entry of errors.slice(0, 10)) {
      if (typeof entry !== "object" || entry === null || !("code" in entry)) continue;
      const code: unknown = entry.code;
      if (typeof code === "number" && Number.isSafeInteger(code) && code > 0 && code <= 99_999_999)
        codes.add(code);
    }
  }
  const headers: Record<string, string> = {};
  for (const [name, pattern] of Object.entries(failureHeaders)) {
    const value = response.headers.get(name);
    if (value !== null && pattern.test(value)) headers[name] = value;
  }
  // Keep only numeric quota parameters; provider-chosen names may contain private data.
  for (const [name, pattern] of [
    ["ratelimit", /^"[^"\r\n]{1,64}"\s*;\s*r=(\d{1,10})\s*;\s*t=(\d{1,10})$/],
    ["ratelimit-policy", /^"[^"\r\n]{1,64}"\s*;\s*q=(\d{1,10})\s*;\s*w=(\d{1,10})$/],
  ] as const) {
    const value = response.headers.get(name);
    if (value === null || value.length > 256) continue;
    const quotas = value
      .split(",")
      .slice(0, 4)
      .flatMap((item) => {
        const match = pattern.exec(item.trim());
        if (!match) return [];
        return [
          name === "ratelimit" ? `r=${match[1]};t=${match[2]}` : `q=${match[1]};w=${match[2]}`,
        ];
      });
    if (quotas.length) headers[name] = quotas.join(", ");
  }
  return new Error(`${message}; diagnostics=${JSON.stringify({ codes: [...codes], headers })}`);
}

/** The Cloudflare v4 envelope: `result` plus, on list routes, pagination `result_info`. */
async function envelope<T>(
  response: Response,
  operation: string,
): Promise<{ result: T; result_info?: Record<string, unknown> }> {
  if (!response.ok)
    throw await apiFailure(
      response,
      `Cloudflare Artifacts ${operation} failed with HTTP ${response.status}`,
    );
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("result" in body))
    throw new Error(`Cloudflare Artifacts ${operation} returned an invalid response`);
  if ("success" in body && body.success !== true)
    throw await apiFailure(response, `Cloudflare Artifacts ${operation} was rejected`, body);
  const info = "result_info" in body ? body.result_info : undefined;
  return {
    result: body.result as T,
    ...(typeof info === "object" && info !== null
      ? { result_info: info as Record<string, unknown> }
      : {}),
  };
}

async function bodyResult<T>(response: Response, operation: string): Promise<T> {
  return (await envelope<T>(response, operation)).result;
}

/** Cloudflare Artifacts API; responses and errors never include credentials or hostnames. */
export function cloudflareArtifactsApi(
  account: string,
  token: string,
  fetcher: ArtifactsFetch = fetch,
): ArtifactsApi {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/artifacts`;
  const request = (url: string | URL, method: string, body?: unknown) =>
    fetcher(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const list = async <T>(url: string, cursor?: string) => {
    const target = new URL(url);
    target.searchParams.set("limit", "200");
    if (cursor) target.searchParams.set("cursor", cursor);
    // Pages keep the envelope: the items are `result` and the next cursor is in `result_info`.
    const page = await envelope<T[]>(await request(target, "GET"), "list");
    const next = page.result_info?.cursor;
    return {
      result: page.result,
      result_info: { cursor: typeof next === "string" ? next : undefined },
    };
  };
  return {
    listNamespaces: (cursor) => list(`${base}/namespaces`, cursor),
    createNamespace: async (name) => {
      const response = await request(`${base}/namespaces`, "POST", {
        namespace: name,
        jurisdiction: "eu",
      });
      const result = await bodyResult<Namespace>(response, "namespace creation");
      if (typeof result?.namespace !== "string" || typeof result.jurisdiction !== "string")
        throw new Error("Cloudflare Artifacts namespace creation returned invalid attributes");
      return result;
    },
    deleteNamespace: async (name) => {
      const response = await request(`${base}/namespaces/${encodeURIComponent(name)}`, "DELETE");
      if (response.status === 404 || response.status === 204) return;
      if (!response.ok)
        throw await apiFailure(
          response,
          `Cloudflare Artifacts namespace deletion failed with HTTP ${response.status}`,
        );
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
        throw await apiFailure(
          response,
          `Cloudflare Artifacts repository deletion failed with HTTP ${response.status}`,
        );
    },
    // The token route pages by number (`page`, `per_page`, `total_pages`), not by cursor. The page
    // number travels as the cursor so every list shares one loop.
    listRepositoryTokens: async (namespace, repository, cursor) => {
      const page = cursor === undefined ? 1 : Number(cursor);
      const target = new URL(
        `${base}/namespaces/${encodeURIComponent(namespace)}/repos/${encodeURIComponent(repository)}/tokens`,
      );
      target.searchParams.set("per_page", "100");
      target.searchParams.set("page", String(page));
      const body = await envelope<Token[]>(await request(target, "GET"), "token list");
      const totalPages = body.result_info?.total_pages;
      if (typeof totalPages !== "number" || !Number.isInteger(totalPages) || totalPages < 0)
        throw new Error("Cloudflare Artifacts token list has no page count");
      return {
        result: body.result,
        result_info: { cursor: page < totalPages ? String(page + 1) : undefined },
      };
    },
    deleteToken: async (namespace, tokenId) => {
      const response = await request(
        `${base}/namespaces/${encodeURIComponent(namespace)}/tokens/${encodeURIComponent(tokenId)}`,
        "DELETE",
      );
      if ([202, 204, 404].includes(response.status)) return;
      if (!response.ok)
        throw await apiFailure(
          response,
          `Cloudflare Artifacts token deletion failed with HTTP ${response.status}`,
        );
    },
  };
}

const maximumPages = 1000;

async function allPages<T>(read: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const results: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await read(cursor);
    if (!Array.isArray(page?.result)) throw new Error("Invalid Cloudflare Artifacts list response");
    results.push(...page.result);
    const next = page.result_info?.cursor || undefined;
    if (next && seen.has(next))
      throw new Error("Cloudflare Artifacts pagination repeated a cursor");
    if (next) seen.add(next);
    // The docs do not define the last cursor; a provider that keeps issuing fresh ones must not hang a deploy.
    if (next && seen.size >= maximumPages)
      throw new Error("Cloudflare Artifacts pagination did not end");
    cursor = next;
  } while (cursor);
  return results;
}

const hasNamespace = async (api: ArtifactsApi, name: string) =>
  (await allPages((cursor) => api.listNamespaces(cursor))).find((item) => item.namespace === name);

/** A successful paginated provider read must confirm the namespace itself is gone. */
export async function euNamespaceExists(api: ArtifactsApi, name: string): Promise<boolean> {
  return (await hasNamespace(api, name)) !== undefined;
}

export async function requireEuNamespaceAbsent(api: ArtifactsApi, name: string): Promise<void> {
  if (await euNamespaceExists(api, name))
    throw new Error("Preview Artifacts namespace is still present");
}

/** Every page is inspected before creating a namespace with immutable EU jurisdiction. */
export async function ensureEuNamespace(api: ArtifactsApi, name: string): Promise<void> {
  let namespace = await hasNamespace(api, name);
  if (!namespace) namespace = await api.createNamespace(name);
  if (namespace.namespace !== name || namespace.jurisdiction !== "eu")
    throw new Error("Artifacts namespace must have immutable EU jurisdiction; deployment stopped");
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Delete the per-stage repositories before its namespace and read back both absences. */
export async function deleteEuNamespace(
  api: ArtifactsApi,
  name: string,
  options: {
    readonly attempts?: number;
    readonly delayMs?: number;
    readonly wait?: (ms: number) => Promise<void>;
  } = {},
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
    const tokens = await allPages((cursor) =>
      api.listRepositoryTokens(name, repository.name, cursor),
    );
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

/**
 * Vault repositories live beside a stage's app sources, in their own namespace, so the two
 * workloads keep separate request-rate limits and a preview teardown removes both.
 */
export function vaultNamespace(sourceNamespace: string): string {
  const name = `${sourceNamespace.replace(/-apps$/u, "")}-vaults`;
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(name))
    throw new Error("Invalid Artifacts vault namespace");
  return name;
}

/** Every namespace a stage owns, app sources first. */
export const stageNamespaces = (sourceNamespace: string) => [
  sourceNamespace,
  vaultNamespace(sourceNamespace),
];

async function main(): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Missing Cloudflare deploy credentials");
  const api = cloudflareArtifactsApi(account, token);
  for (const namespace of stageNamespaces(
    process.env.CLOUD_SOURCE_NAMESPACE ?? deployment.sourceNamespace,
  ))
    await ensureEuNamespace(api, namespace);
  console.log("Artifacts namespaces use EU jurisdiction");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
