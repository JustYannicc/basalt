/** Route labels are selected from constants, never copied from a caller's URL. */
export function pageTemplate(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/other";
  const path = value.split(/[?#]/, 1)[0]!;
  if (["/", "/login", "/signup", "/setup"].includes(path)) return path;
  if (/^\/setup\/claim\//.test(path)) return "/setup/claim/:token";
  if (/^\/setup\/v1\//.test(path)) return "/setup/v1/:action";
  if (/^\/pool\/v1\//.test(path)) return "/pool/v1/:action";
  if (/^\/v1(?:\/|$)/.test(path)) return "/v1/:operation";
  if (/^\/mcp(?:\/|$)/.test(path)) return "/mcp";
  if (/^\/api\/auth\//.test(path)) return "/api/auth/:action";
  if (/^\/api\//.test(path)) return "/api/:operation";
  if (/^\/organizations(?:\/|$)/.test(path)) return "/organizations/:id";
  if (/^\/apps(?:\/|$)/.test(path)) return "/apps/:id";
  if (/^\/feedback\/v1\//.test(path)) return "/feedback/v1/:action";
  return "/other";
}
const codes = new Set(["script_error", "unhandled_rejection", "resource_error", "http_5xx", "feedback_submit_failed", "router_failure", "pool_failure"]);
export function errorCode(value: unknown): string | undefined {
  return typeof value === "string" && (codes.has(value) || /^http_5\d\d$/.test(value)) ? value : undefined;
}
export function recentErrors(value: unknown): { code: string }[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-10).flatMap((entry) => {
    const code = errorCode(entry && typeof entry === "object" ? entry.code : undefined);
    return code ? [{ code }] : [];
  });
}
