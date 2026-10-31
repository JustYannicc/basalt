import { isControlPath } from "../apps/pool/contract.ts";
import { isPublicModelPath } from "./pool/lifecycle.ts";
import { appHosting, brand } from "../brand.ts";
import { handleSetup, handleSetupPage } from "./setup/host.ts";
import { handleShare } from "./setup/share.ts";
import { observeToolCall } from "./setup/tool-observation.ts";
import { handleFeedback } from "./feedback/host.ts";
import { handleRelay, type RelayEnv } from "./telemetry/relay.ts";
import { captureProduct } from "./telemetry/product.ts";
import { traceRequest, type TraceEnv } from "./telemetry/traces.ts";
import { validSentryDsn } from "./telemetry/sentry.ts";
import type { $ElementId } from "../scripts/architecture/gen/model.ts";
import { nativeAuthenticationHeader, nativeModelRequest } from "./native-model.ts";
import { nativeControlPath } from "./pool/native-contract.ts";
import { nativeSessionPath } from "./pool/native-contract.ts";
import { tunnelPath } from "../clients/contracts/tunnel.ts";
import { handleTunnel } from "./tunnel/host.ts";

// Service bindings name the same gateways as the architecture.
export const serviceArchitecture = {
  TOOLS_SERVICE: "basalt.toolsGateway",
  CATALOG_SERVICE: "basalt.catalog",
  APP_UI_SERVICE: "basalt.toolsGateway",
  ASSETS: "basalt.clientAssets",
  POOL_SERVICE: "basalt.modelGateway",
} satisfies Record<"TOOLS_SERVICE" | "POOL_SERVICE" | "CATALOG_SERVICE" | "APP_UI_SERVICE" | "ASSETS", $ElementId>;

interface Service {
  fetch(request: Request): Promise<Response>;
}

export interface RouterEnv extends RelayEnv, TraceEnv {
  ASSETS?: Service;
  DASHBOARD_HOST?: string;
  TOOLS_SERVICE: Service;
  APP_UI_SERVICE?: Service;
  CATALOG_SERVICE: Service;
  POOL_SERVICE: Service;
  POOL_APP_SIGNING_KEY: string;
}

function isPoolPath(pathname: string): boolean {
  return isPublicModelPath(pathname) || isControlPath(pathname);
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
export const sessionCookiePrefix = "__Host-executor-hosted";
const sessionCookie = new RegExp(
  `(?:^|;\\s*)${sessionCookiePrefix}\\.session_token=[^;\\s]`,
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

/** Router-owned HTML is never embeddable, including assets and local error pages. */
function denyFraming(response: Response): Response {
  if (!/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
    return response;
  const protectedResponse = new Response(response.body, response);
  const policy = (response.headers.get("content-security-policy") ?? "")
    .split(";").map((directive) => directive.trim()).filter((directive) => directive && !/^frame-ancestors\b/i.test(directive));
  protectedResponse.headers.set("Content-Security-Policy", [...policy, "frame-ancestors 'none'"].join("; "));
  protectedResponse.headers.set("X-Frame-Options", "DENY");
  return protectedResponse;
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

async function routeRequest(request: Request, env: RouterEnv, context?: { waitUntil(work: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  // Reserve only a-<UUID> app labels. Product hosts never enter the app-origin handler.
  if (url.hostname !== (env.DASHBOARD_HOST ?? brand.host)) {
    const label = url.hostname.slice(0, -(appHosting.zone.length + 1));
    if (url.hostname.endsWith(`.${appHosting.zone}`) && /^a-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(label))
      return env.APP_UI_SERVICE?.fetch(request) ?? Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  // Run before static assets on all hosts, then serve assets only on this router's dashboard host.
  if (env.ASSETS && (request.method === "GET" || request.method === "HEAD")) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return denyFraming(asset);
  }
  const { search } = url;
  const pathname = servicePath(url.pathname);
  if (pathname === "/native/device" || pathname === "/native/device/") {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
    const asset = await env.ASSETS?.fetch(new Request(new URL("/native-device/index.html", url), { method: request.method }));
    if (!asset || asset.status === 404) return notFoundPage();
    const page = new Response(asset.body, asset);
    page.headers.set("Cache-Control", "no-store");
    page.headers.set("Referrer-Policy", "no-referrer");
    return page;
  }
  if (pathname === tunnelPath) return handleTunnel(request, env, context);
  if (pathname === nativeSessionPath) return Promise.resolve(notFoundPage());
  if (pathname.startsWith("/catalog/")) return env.CATALOG_SERVICE.fetch(request);
  if (pathname.startsWith("/feedback/v1/")) return handleFeedback(request, env);
  if (pathname.startsWith("/__telemetry/")) return handleRelay(request, env);
  if (pathname === "/setup" || pathname === "/setup/") return handleSetupPage(request, env);
  if (pathname.startsWith("/setup/v1/") || pathname.startsWith("/setup/claim/")) return handleSetup(request, {
    ...env,
    onProductEvent: (event, accountId) => {
      const work = captureProduct(env, event, accountId);
      context?.waitUntil(work);
    },
  });
  if (pathname.startsWith("/share/v1/")) return handleShare(request, env);
  // Internal setup assertions are sent only through the private binding by the setup host.
  if (pathname.startsWith("/__setup/")) return Promise.resolve(notFoundPage());
  if (pathname === nativeControlPath) return env.POOL_SERVICE.fetch(request);
  if (isPoolManagementPath(pathname)) {
    return Promise.resolve(new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } }));
  }
  if (isPoolPath(pathname)) {
    if (isPublicModelPath(pathname) && request.headers.get(nativeAuthenticationHeader) === "1")
      return nativeModelRequest(request, env);
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

  const observed = pathname === "/mcp" && request.method === "POST" && request.headers.has("authorization") ? request.clone() : undefined;
  return env.TOOLS_SERVICE.fetch(request).then(withBrandNotFound).then((response) => {
    if (observed && context) context.waitUntil(observeToolCall(observed, response.clone(), env));
    return response;
  });
}

export async function handleRequest(request: Request, env: RouterEnv, context?: { waitUntil(work: Promise<unknown>): void }): Promise<Response> {
  // Relays contain explicit feedback and must not recursively instrument their own exports.
  const tracing = validSentryDsn(env.SENTRY_DSN);
  const response = tracing
    ? await traceRequest(env, request, (forwarded) => routeRequest(forwarded, env, context), context)
    : await routeRequest(request, env, context);
  const url = new URL(request.url);
  if (url.hostname !== (env.DASHBOARD_HOST ?? brand.host)) return response;
  // Only the tools service's auth route may retain its explicit same-origin exception.
  if (url.pathname === "/app-auth" && response.headers.get("content-security-policy") === "frame-ancestors 'self'" && response.headers.get("x-frame-options") === "SAMEORIGIN")
    return response;
  return denyFraming(response);
}

export default { fetch: handleRequest };
