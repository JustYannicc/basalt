/** The entire product-event vocabulary. No browser SDK, autocapture or person profiles. */
export const productEvents = [
  "sign_up", "pool_created", "account_connected", "invite_sent", "invite_accepted",
  "setup_started", "setup_completed", "first_model_request", "connector_installed",
  "connector_connect_failed", "tool_called", "tool_search_empty", "service_requested",
] as const;
export type ProductEvent = typeof productEvents[number];
export interface TelemetryEnv { POSTHOG_PROJECT_KEY?: string; SENTRY_DSN?: string }
export interface ProductProperties { app_id?: string; service_id?: string }
export interface ProductRecord { event: ProductEvent; accountId: string; properties?: ProductProperties; timestamp?: string }
const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}

/** Reject extra fields instead of trying to redact arbitrary content after collection. */
export function productPayload(event: ProductEvent, accountId: string, properties: ProductProperties = {}) {
  if (!(productEvents as readonly string[]).includes(event) || !isAccountId(accountId))
    throw new Error("Invalid product event");
  const permitted = event === "service_requested" ? ["service_id"]
    : ["tool_called", "connector_installed", "connector_connect_failed"].includes(event) ? ["app_id"] : [];
  if (Object.entries(properties).some(([key, value]) => !permitted.includes(key) || !isAccountId(value)))
    throw new Error("Invalid product properties");
  if (event === "service_requested" && !properties.service_id) throw new Error("Missing catalog service");
  if (event === "tool_called" && !properties.app_id) throw new Error("Missing resolved app");
  return {
    event, distinct_id: accountId,
    properties: { ...properties, $process_person_profile: false, $geoip_disable: true, ip: null },
  };
}

/** Analytics never changes the result of the operation that produced it. */
export async function captureProduct(env: TelemetryEnv, event: ProductEvent, accountId: string, properties: ProductProperties = {}): Promise<void> {
  await captureProducts(env, [{ event, accountId, properties }]);
}

/** One bounded HTTP request per upstream batch, with no person or location enrichment. */
export async function captureProducts(env: TelemetryEnv, events: readonly ProductRecord[]): Promise<boolean> {
  if (!env.POSTHOG_PROJECT_KEY || !events.length) return true;
  try {
    if (events.length > 2000) return false;
    const now = new Date().toISOString();
    const batch = events.map(({ event, accountId, properties, timestamp = now }) => {
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))
        throw new Error("Invalid event timestamp");
      return { ...productPayload(event, accountId, properties), timestamp };
    });
    const response = await fetch("https://eu.i.posthog.com/batch/", {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual",
      body: JSON.stringify({ api_key: env.POSTHOG_PROJECT_KEY, batch }),
      signal: AbortSignal.timeout(3_000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}
