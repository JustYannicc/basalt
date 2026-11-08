import { homeWith, sitePage } from "./pages.ts";
import { joinWaitlist, type WaitlistDatabase, type WaitlistRateLimit } from "./waitlist.ts";

/** No scripts, frames or other origins. The one form posts back to this site. */
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; font-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
const uncached = { ...headers, "Cache-Control": "no-store" };

/** Every page may be indexed. */
const robots = "User-agent: *\nAllow: /\n";

export interface SiteEnv {
  readonly WAITLIST: WaitlistDatabase;
  readonly WAITLIST_LIMIT: WaitlistRateLimit;
}

// An email address and an empty trap field fit with room to spare.
const maxFormBytes = 2048;

async function join(request: Request, env: SiteEnv): Promise<Response> {
  const page = (status: number, state: "invalid" | "limited") =>
    new Response(homeWith(state), { status, headers: uncached });
  // Another site can't sign people up through their browsers.
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded"))
    return new Response(null, { status: 415 });
  if (Number(request.headers.get("Content-Length") ?? 0) > maxFormBytes)
    return new Response(null, { status: 413 });
  const body = await request.text();
  if (body.length > maxFormBytes) return new Response(null, { status: 413 });
  const form = new URLSearchParams(body);
  const result = await joinWaitlist(
    {
      email: form.get("email"),
      honeypot: form.get("website"),
      client: request.headers.get("CF-Connecting-IP") ?? "unknown",
    },
    env.WAITLIST,
    env.WAITLIST_LIMIT,
  );
  if (result === "invalid") return page(400, "invalid");
  if (result === "limited") return page(429, "limited");
  // See Other turns the POST into a GET, so reloading the result doesn't send the form again.
  return new Response(null, { status: 303, headers: { Location: "/waitlist", "Cache-Control": "no-store" } });
}

/** The brand's logo and fonts come from static assets first; every other path lands here. */
export async function handleSite(request: Request, env: SiteEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method === "POST" && pathname === "/waitlist") return join(request, env);
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { Allow: pathname === "/waitlist" ? "GET, HEAD, POST" : "GET, HEAD" },
    });
  if (pathname === "/robots.txt")
    return new Response(request.method === "HEAD" ? null : robots, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" },
    });
  const { status, html } = sitePage(pathname);
  return new Response(request.method === "HEAD" ? null : html, {
    status,
    headers: status === 404 ? uncached : headers,
  });
}

export default { fetch: handleSite };
