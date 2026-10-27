/**
 * Paths whose callers are API, MCP, model, OAuth, webhook, Git and installer clients rather than browsers.
 * The zone keeps its Browser Integrity Check for everything else, including the app's own pages.
 */
const apiBases = ["/v1", "/pool/v1", "/api", "/catalog", "/.well-known", "/git", "/setup/claim"];
const apiExactPaths = [
  // MCP is served only here and at the organization path; `/mcp/*` holds consent and approval pages.
  "/mcp",
  // Model paths the gateway also serves without a version prefix.
  "/messages", "/chat/completions", "/completions",
  "/openapi.json", "/oauth/client-metadata.json",
  // The setup command downloads the installer with Node or PowerShell.
  "/setup/client.mjs",
];
/** Organization MCP endpoints, `/org/<organization>/mcp`. */
const orgMcp = { prefix: "/org/", suffix: "/mcp" } as const;

/** A base matches itself and everything below it. */
export function isApiPath(pathname: string): boolean {
  return apiExactPaths.includes(pathname)
    || apiBases.some((base) => pathname === base || pathname.startsWith(`${base}/`))
    || (pathname.startsWith(orgMcp.prefix) && pathname.endsWith(orgMcp.suffix));
}

/** Rule expression matching the API paths on one host, with the same matching as `isApiPath`. */
export function apiPathsExpression(host: string): string {
  if (!/^[a-z0-9.-]+$/.test(host)) throw new Error("Host must be a plain DNS name");
  const path = "http.request.uri.path";
  const exact = [...apiBases, ...apiExactPaths].map((value) => `"${value}"`).join(" ");
  const prefixes = apiBases.map((base) => `starts_with(${path}, "${base}/")`).join(" or ");
  const org = `(starts_with(${path}, "${orgMcp.prefix}") and ends_with(${path}, "${orgMcp.suffix}"))`;
  return `(http.host eq "${host}" and (${path} in {${exact}} or ${prefixes} or ${org}))`;
}
