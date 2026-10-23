import { isControlPath } from "../apps/pool/contract.ts";
import { brand } from "../brand.ts";
import type { $ElementId } from "../scripts/architecture/gen/model.ts";

// Service bindings name the same gateways as the architecture.
export const serviceArchitecture = {
  TOOLS_SERVICE: "basalt.toolsGateway",
  POOL_SERVICE: "basalt.modelGateway",
} satisfies Record<keyof RouterEnv, $ElementId>;

interface Service {
  fetch(request: Request): Promise<Response>;
}

export interface RouterEnv {
  TOOLS_SERVICE: Service;
  POOL_SERVICE: Service;
}

function isPoolPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/") || isControlPath(pathname);
}

function isPoolManagementPath(pathname: string): boolean {
  return /^\/v(?:0|8)\/management(?:\/|$)/.test(pathname);
}

/**
 * The tools service's own marketing site, docs and legal pages, which its Worker serves on every
 * host. They present the tools service, so the router never forwards them. `/x/*` also covers `/x`.
 */
export const toolsServiceSitePages = [
  "/home",
  "/pricing",
  "/pricing.md",
  "/index.md",
  "/setup-prompt.md",
  "/llms.txt",
  "/about-executor",
  "/google-workspace",
  "/google-oauth",
  "/privacy",
  "/terms",
  "/blog/*",
  "/docs/*",
  "/apps/*",
  "/experiments/*",
] as const;

/**
 * Static files of that site, served by the tools service's asset layer before its code runs. The
 * router's own `public/_redirects` sends the icons among them to the brand's logo.
 */
export const toolsServiceSiteFiles = [
  "/_astro/*",
  "/authors/*",
  "/favicon-32.png",
  "/favicon-192.png",
  "/apple-touch-icon.png",
  "/og-image.png",
  "/pattern-graph-paper.svg",
] as const;

const sitePaths = [...toolsServiceSitePages, ...toolsServiceSiteFiles];
const exactPages = new Set<string>(sitePaths.filter((page) => !page.endsWith("/*")));
const pagePrefixes = sitePaths.filter((page) => page.endsWith("/*")).map((page) => page.slice(0, -2));

/** A trailing slash names the same page, as it does for the tools service. */
function isToolsServiceSitePage(pathname: string): boolean {
  // The site's pages are also files: `/index.html`, `/404.html`, `/pricing/index.html`. The
  // dashboard serves no `.html` path.
  if (pathname.endsWith(".html")) return true;
  const page = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return (
    exactPages.has(page) ||
    pagePrefixes.some((prefix) => page === prefix || page.startsWith(`${prefix}/`))
  );
}

/** The tools service's Better Auth cookie prefix; its sign-in still checks the session. */
export const sessionCookiePrefix = "executor-hosted";
const sessionCookie = new RegExp(
  `(?:^|;\\s*)(?:__Secure-)?${sessionCookiePrefix}\\.session_token=[^;\\s]`,
);

function hasSessionCookie(request: Request): boolean {
  return sessionCookie.test(request.headers.get("cookie") ?? "");
}

const escapeHtml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The brand's own not-found page, in place of the tools service's marketing one. */
export function notFoundPage(product: { name: string; logo: string } = brand): Response {
  const name = escapeHtml(product.name);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page not found · ${name}</title><link rel="icon" href="${escapeHtml(product.logo)}"><body style="font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh"><main style="text-align:center"><img src="${escapeHtml(product.logo)}" alt="" width="40" height="40"><h1 style="font-size:20px">Page not found</h1><p><a href="/">Open ${name}</a></p></main></body></html>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/**
 * A miss on a path the dashboard doesn't own gets the tools service's marketing 404 page. Its own
 * pages carry `data-dashboard`, so they pass through; any other HTML 404 becomes the brand's.
 */
async function withBrandNotFound(response: Response): Promise<Response> {
  if (response.status !== 404 || !response.headers.get("content-type")?.includes("text/html"))
    return response;
  const html = await response.text();
  return html.includes("data-dashboard") ? new Response(html, response) : notFoundPage();
}

/** Where the brand's own docs and legal pages live, when it has them. */
function brandPage(pathname: string): string | null {
  const [, section] = pathname.split("/");
  if (section === "privacy") return brand.links.privacy;
  if (section === "terms") return brand.links.terms;
  if (section === "docs") return brand.links.docs;
  return null;
}

/**
 * The path as the tools service's router matches it: cut at `;`, repeated slashes merged,
 * decoded and lowercased. `/;` and `//pricing` would otherwise reach its homepage and site.
 */
function servicePath(pathname: string): string {
  const path = pathname.split(";")[0]!.replace(/\/{2,}/g, "/");
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A malformed escape reaches the tools service, which refuses it.
  }
  return decoded.toLowerCase() || "/";
}

export function handleRequest(request: Request, env: RouterEnv): Promise<Response> {
  const url = new URL(request.url);
  const { search } = url;
  const pathname = servicePath(url.pathname);
  if (isPoolManagementPath(pathname)) {
    return Promise.resolve(new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } }));
  }
  if (isPoolPath(pathname)) {
    return env.POOL_SERVICE.fetch(request);
  }
  // Signed out, the tools service's homepage is its marketing page; sign-in sends people on.
  if (
    pathname === "/" &&
    (request.method === "GET" || request.method === "HEAD") &&
    !hasSessionCookie(request)
  ) {
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { Location: `/login${search}`, "Cache-Control": "no-store" },
      }),
    );
  }
  if (isToolsServiceSitePage(pathname)) {
    const page = brandPage(pathname);
    return Promise.resolve(
      page === null
        ? notFoundPage()
        : new Response(null, { status: 302, headers: { "Cache-Control": "no-store", Location: page } }),
    );
  }

  return env.TOOLS_SERVICE.fetch(request).then(withBrandNotFound);
}

export default { fetch: handleRequest };
