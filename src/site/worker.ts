import { sitePage } from "./pages.ts";

/** Static pages only: no scripts, no forms, no frames, nothing loaded from another origin. */
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Every page may be indexed. */
const robots = "User-agent: *\nAllow: /\n";

/** The brand's logo and fonts come from static assets first; every other path lands here. */
export function handleSite(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const { pathname } = new URL(request.url);
  if (pathname === "/robots.txt")
    return new Response(request.method === "HEAD" ? null : robots, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  const { status, html } = sitePage(pathname);
  return new Response(request.method === "HEAD" ? null : html, {
    status,
    headers: status === 404 ? { ...headers, "Cache-Control": "no-store" } : headers,
  });
}

export default { fetch: handleSite };
