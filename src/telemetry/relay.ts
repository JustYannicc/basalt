import { captureProducts, isAccountId, type ProductEvent, type ProductRecord, type ProductProperties, type TelemetryEnv } from "./product.ts";
import { sendFeedback } from "./sentry.ts";
import { exact, object, readJson, telemetryResponse, TelemetryInputError } from "./http.ts";
export interface RelayEnv extends TelemetryEnv { TELEMETRY_RELAY_KEY?: string }
const mapping: Record<string, ProductEvent> = {
  cloud_signup_completed: "sign_up",
  account_connected: "account_connected",
  app_installed: "connector_installed",
  account_connection_failed: "connector_connect_failed",
  invitation_sent: "invite_sent",
  invitation_accepted: "invite_accepted",
  tool_execution_completed: "tool_called",
  tool_search_empty: "tool_search_empty",
};
async function authorized(request: Request, key: string | undefined): Promise<boolean> {
  if (!key || key.length < 32) return false;
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${key}`)),
    crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? "")),
  ]);
  const a = new Uint8Array(expected), b = new Uint8Array(actual);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

/** This receiver never accepts queries, organization identity, or arbitrary event properties. */
export async function handleRelay(request: Request, env: RelayEnv): Promise<Response> {
  try {
    const path = new URL(request.url).pathname;
    if (!["/__telemetry/v1/analytics", "/__telemetry/v1/feedback"].includes(path)) return telemetryResponse(404);
    if (!await authorized(request, env.TELEMETRY_RELAY_KEY)) return telemetryResponse(404);
    if (request.method !== "POST") return telemetryResponse(405);
    const input = await readJson(request, 262_144);
    if (path.endsWith("/feedback")) {
      exact(input, ["message", "account_id"]);
      if (!isAccountId(input.account_id) || typeof input.message !== "string" || !input.message.trim())
        throw new TelemetryInputError(400);
      if (input.message.length > 4000) throw new TelemetryInputError(413);
      return telemetryResponse(await sendFeedback(env, { accountId: input.account_id, message: input.message, page: "/mcp" }) ? 204 : 503);
    }
    exact(input, ["events"]);
    if (!Array.isArray(input.events) || input.events.length > 1000) throw new TelemetryInputError(400);
    // Validate the entire batch before any external effect.
    const events = input.events.map((value) => {
      const event = object(value);
      exact(event, ["event", "account_id", "timestamp", "properties"]);
      if (typeof event.event !== "string" || !Object.hasOwn(mapping, event.event) || !isAccountId(event.account_id)
        || typeof event.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.timestamp) || !Number.isFinite(Date.parse(event.timestamp)))
        throw new TelemetryInputError(400);
      const properties = object(event.properties);
      const allowed = event.event === "tool_search_empty" ? ["service_id"]
        : ["tool_execution_completed", "app_installed", "account_connection_failed"].includes(event.event) ? ["app_id"] : [];
      exact(properties, allowed);
      if (Object.values(properties).some((value) => !isAccountId(value))) throw new TelemetryInputError(400);
      return { event: mapping[event.event]!, accountId: event.account_id, timestamp: event.timestamp, properties: properties as ProductProperties };
    });
    const batch: ProductRecord[] = [];
    for (const event of events) {
      if (event.event === "tool_search_empty") {
        batch.push({ ...event, properties: {} });
        if (event.properties.service_id) batch.push({ ...event, event: "service_requested" });
      } else if (event.event !== "tool_called" || event.properties.app_id) batch.push(event);
    }
    return telemetryResponse(await captureProducts(env, batch) ? 204 : 503);
  } catch (error) { return telemetryResponse(error instanceof TelemetryInputError ? error.status : 503); }
}
