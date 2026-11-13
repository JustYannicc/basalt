/** Route labels are selected from constants, never copied from a caller's URL. */
const dashboardSections = new Set([
  "apps",
  "connections",
  "accounts",
  "approvals",
  "groups",
  "settings",
  "connect",
]);
export function pageTemplate(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//"))
    return "/other";
  const path = value.split(/[?#]/, 1)[0]!;
  if (["/", "/login", "/signup", "/setup"].includes(path)) return path;
  if (path.startsWith("/setup/claim/")) return "/setup/claim/:token";
  if (path.startsWith("/setup/v1/")) return "/setup/v1/:action";
  if (path.startsWith("/pool/v1/")) return "/pool/v1/:action";
  if (/^\/v1(?:\/|$)/.test(path)) return "/v1/:operation";
  if (/^\/mcp(?:\/|$)/.test(path)) return "/mcp";
  if (path.startsWith("/api/auth/")) return "/api/auth/:action";
  if (path.startsWith("/api/")) return "/api/:operation";
  if (/^\/organizations(?:\/|$)/.test(path)) return "/organizations/:id";
  if (/^\/apps(?:\/|$)/.test(path)) return "/apps/:id";
  // Dashboard pages name their section, never the organization.
  const dashboard = /^\/org\/[^/]+(?:\/([a-z-]+))?/.exec(path);
  if (dashboard) {
    const section = dashboard[1];
    return section !== undefined && dashboardSections.has(section)
      ? `/org/:slug/${section}`
      : "/org/:slug";
  }
  if (path.startsWith("/feedback/v1/")) return "/feedback/v1/:action";
  return "/other";
}
const codes = new Set([
  "script_error",
  "unhandled_rejection",
  "resource_error",
  "http_5xx",
  "feedback_submit_failed",
  "router_failure",
  "pool_failure",
  "pool_terminal_failure",
  "pool_terminal_collection_unavailable",
]);
export function errorCode(value: unknown): string | undefined {
  return typeof value === "string" && (codes.has(value) || /^http_5\d\d$/.test(value))
    ? value
    : undefined;
}
export function recentErrors(value: unknown): { code: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-10).flatMap((entry) => {
    const code = errorCode(entry && typeof entry === "object" ? entry.code : undefined);
    return code ? [{ code }] : [];
  });
}
