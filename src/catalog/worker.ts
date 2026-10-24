import { mergeFeed, type Addition, type Feed } from "./feed.ts";
import { catalog } from "./settings.ts";
import { atlassianAddition } from "./atlassian/index.ts";

// Missing connectors add their published package here. Existing official apps stay upstream's.
const additions: readonly Addition[] = [atlassianAddition()];
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
  "X-Content-Type-Options": "nosniff",
};
const unavailable = () => new Response('{"error":"Catalog unavailable"}', {
  status: 502, headers: { ...headers, "Cache-Control": "no-store" },
});

/** A read-only feed. Never forward cookies, authorization or query parameters to its publisher. */
export async function handleCatalog(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const path = new URL(request.url).pathname;
  const relative = path.startsWith(catalog.path) ? path.slice(catalog.path.length) : "";
  if (relative !== "index.json" && !/^apps\/[a-zA-Z0-9_-]+\.json$/.test(relative))
    return new Response(null, { status: 404 });
  const added = additions.find(item => relative === `apps/${encodeURIComponent(item.entry.id)}.json`);
  if (added) return new Response(request.method === "HEAD" ? null : JSON.stringify(added.source), { headers });
  try {
    const response = await fetcher(new URL(relative, catalog.official), {
      redirect: "manual", signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json" },
    });
    if (response.status === 404) return new Response(null, { status: 404, headers });
    if (!response.ok || response.status !== 200) return unavailable();
    const body = relative === "index.json"
      ? JSON.stringify(mergeFeed(await response.json() as Feed, additions))
      : await response.text();
    return new Response(request.method === "HEAD" ? null : body, { headers });
  } catch {
    return unavailable();
  }
}

export default { fetch: (request: Request) => handleCatalog(request) };
