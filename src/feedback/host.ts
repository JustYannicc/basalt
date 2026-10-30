import { isAccountId } from "../telemetry/product.ts";
import { pageTemplate } from "../telemetry/privacy.ts";
import { sendFeedback, type SentryEnv } from "../telemetry/sentry.ts";
import { exact, object, readJson, telemetryResponse, TelemetryInputError } from "../telemetry/http.ts";
import { feedbackEndpoints, feedbackLimits } from "./ui.ts";
import { feedbackLogs } from "./logs.ts";
interface Service { fetch(request: Request): Promise<Response> }
export interface FeedbackEnv extends SentryEnv { TOOLS_SERVICE: Service }

/** Resolve the native session server-side. Caller-supplied identity never enters feedback. */
async function account(request: Request, env: FeedbackEnv): Promise<string | undefined> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  const result = await env.TOOLS_SERVICE.fetch(new Request(new URL("/api/auth/get-session?disableCookieCache=true&disableRefresh=true", request.url), {
    headers: { Cookie: cookie, Accept: "application/json" }, redirect: "manual",
  }));
  if (!result.ok) return undefined;
  const session = await result.json() as { user?: { id?: unknown } };
  return isAccountId(session?.user?.id) ? session.user.id : undefined;
}
function screenshot(value: unknown): { name: string; type: string; data: string } | undefined {
  if (value === undefined) return undefined;
  const image = object(value);
  exact(image, ["name", "type", "data"]);
  if (typeof image.type !== "string" || !(feedbackLimits.screenshotTypes as readonly string[]).includes(image.type)
    || typeof image.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0)
    throw new TelemetryInputError(400);
  const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
  if (bytes.byteLength > feedbackLimits.screenshotBytesMax) throw new TelemetryInputError(413);
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (image.type === "image/png" ? !png : !jpeg) throw new TelemetryInputError(400);
  return { name: image.type === "image/png" ? "screenshot.png" : "screenshot.jpg", type: image.type, data: image.data };
}

export async function handleFeedback(request: Request, env: FeedbackEnv): Promise<Response> {
  try {
    if (new URL(request.url).pathname !== feedbackEndpoints.submit) return telemetryResponse(404);
    if (request.method !== "POST") return telemetryResponse(405);
    if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.has("authorization")) return telemetryResponse(403);
    const input = await readJson(request, feedbackLimits.submitBodyBytesMax);
    const accountId = await account(request, env);
    if (!accountId) return telemetryResponse(401);
    exact(input, ["message", "page", "screenshot", "logs"]);
    if (typeof input.message !== "string" || !input.message.trim() || input.message.length > feedbackLimits.messageMax)
      throw new TelemetryInputError(400);
    const accepted = await sendFeedback(env, {
      accountId, message: input.message, page: pageTemplate(input.page),
      screenshot: screenshot(input.screenshot), logs: feedbackLogs(input.logs),
    });
    return telemetryResponse(accepted ? 204 : 503);
  } catch (error) { return telemetryResponse(error instanceof TelemetryInputError ? error.status : 503); }
}
