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

/** The body as text, or undefined once it passes the cap, whether or not it declared a length. */
async function boundedText(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("Content-Length") ?? 0) > maxFormBytes) return undefined;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxFormBytes) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function join(request: Request, env: SiteEnv): Promise<Response> {
  // Another site can't sign people up through their browsers.
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin)
    return new Response(null, { status: 403 });
  if (!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded"))
    return new Response(null, { status: 415 });
  const body = await boundedText(request);
  if (body === undefined) return new Response(null, { status: 413 });
  const form = new URLSearchParams(body);
  const result = await joinWaitlist(
    {
      email: form.get("email"),
      honeypot: form.get("leave_empty"),
      client: request.headers.get("CF-Connecting-IP") ?? "unknown",
    },
    env.WAITLIST,
    env.WAITLIST_LIMIT,
  );
  if (result === "invalid")
    return new Response(homeWith(result), { status: 400, headers: uncached });
  if (result === "limited")
    return new Response(homeWith(result), {
      status: 429,
      headers: { ...uncached, "Retry-After": "60" },
    });
  if (result === "failed")
    return new Response(homeWith(result), { status: 503, headers: uncached });
  // See Other turns the POST into a GET, so reloading the result doesn't send the form again.
  return new Response(null, {
    status: 303,
    headers: { Location: "/waitlist", "Cache-Control": "no-store" },
  });
}

/** The brand's logo and fonts come from static assets first; every other path lands here. */
export async function handleSite(request: Request, env: SiteEnv): Promise<Response> {
  const url = new URL(request.url);
  // A trailing slash names the same page, for posts as for reads.
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  if (request.method === "POST" && pathname === "/waitlist") return join(request, env);
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, {
      status: 405,
      headers: { Allow: pathname === "/waitlist" ? "GET, HEAD, POST" : "GET, HEAD" },
    });
  if (pathname === "/robots.txt")
    return new Response(request.method === "HEAD" ? null : robots, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  const { status, html } = sitePage(pathname);
  return new Response(request.method === "HEAD" ? null : html, {
    status,
    headers: status === 404 ? uncached : headers,
  });
}

export default { fetch: handleSite };
