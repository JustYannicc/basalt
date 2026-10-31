import { isAccountId } from "./product.ts";
import { errorCode, pageTemplate, recentErrors } from "./privacy.ts";
import { sentryEnvelopeTarget, type SentryEnv, validSentryDsn } from "./sentry-target.ts";

export type { SentryEnv } from "./sentry-target.ts";
export { validSentryDsn } from "./sentry-target.ts";

export interface FeedbackInput {
  accountId: string;
  /** User-written feedback is the intentional content-bearing exception. */
  message: string;
  page: string;
  errors?: Array<{ code: string }>;
  screenshot?: { type: string; data: string; name: string };
  /** Page log entries, already validated and redacted by the feedback host. */
  logs?: readonly object[] | undefined;
}

interface Attachment {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/jpeg" | "application/json";
  readonly filename: "screenshot.png" | "screenshot.jpg" | "logs.json";
}

const encoder = new TextEncoder();
const screenshotBytesMax = 2 * 1024 * 1024;
const feedbackMessageMax = 4096;
const timeoutMs = 3000;

function eventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withinFeedbackLimit(value: string): boolean {
  let count = 0;
  for (const _character of value) if (++count > feedbackMessageMax) return false;
  return true;
}

function decodeScreenshot(value: FeedbackInput["screenshot"]): Attachment | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return null;
  const contentType = value.type;
  const data = value.data;
  if (
    (contentType !== "image/png" && contentType !== "image/jpeg") ||
    typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) return null;
  try {
    const decoded = atob(data);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (bytes.byteLength > screenshotBytesMax) return null;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if ((contentType === "image/png" && !png) || (contentType === "image/jpeg" && !jpeg)) return null;
    return {
      bytes,
      contentType,
      // Never put the caller's filename into Sentry metadata.
      filename: contentType === "image/png" ? "screenshot.png" : "screenshot.jpg",
    };
  } catch {
    return null;
  }
}

function append(parts: Uint8Array[], value: string | Uint8Array): void {
  parts.push(typeof value === "string" ? encoder.encode(value) : value);
}

function combine(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Build one feedback/error envelope with UTF-8 byte lengths and optional raw attachments. */
function envelope(
  id: string,
  type: "event" | "feedback",
  payload: Record<string, unknown>,
  attachments: readonly Attachment[] = [],
): Uint8Array {
  const item = encoder.encode(JSON.stringify(payload));
  const parts: Uint8Array[] = [
    encoder.encode(`${JSON.stringify({ event_id: id })}\n`),
    encoder.encode(`${JSON.stringify({ type, length: item.byteLength })}\n`),
    item,
    encoder.encode("\n"),
  ];
  for (const attachment of attachments) {
    append(parts, `${JSON.stringify({
      type: "attachment",
      length: attachment.bytes.byteLength,
      filename: attachment.filename,
      content_type: attachment.contentType,
      attachment_type: "event.attachment",
    })}\n`);
    append(parts, attachment.bytes);
    append(parts, "\n");
  }
  return combine(parts);
}

async function postEnvelope(env: SentryEnv, body: Uint8Array): Promise<boolean> {
  const target = sentryEnvelopeTarget(env);
  if (!target) return false;
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": target.authHeader,
      },
      body: new Uint8Array(body).buffer,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

/** Send explicit feedback text, an optional bounded screenshot and redacted page logs, with no automatic PII. */
export async function sendFeedback(env: SentryEnv, input: FeedbackInput): Promise<boolean> {
  if (
    !validSentryDsn(env.SENTRY_DSN) || !isAccountId(input.accountId) ||
    typeof input.message !== "string" || !input.message.trim() || !withinFeedbackLimit(input.message)
  ) return false;
  const screenshot = decodeScreenshot(input.screenshot);
  if (screenshot === null) return false;

  const id = eventId();
  const page = pageTemplate(input.page);
  const payload: Record<string, unknown> = {
    event_id: id,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    user: { id: input.accountId },
    contexts: {
      feedback: { message: input.message, url: page },
      basalt: { recent_error_codes: recentErrors(input.errors).map(({ code }) => code) },
    },
  };
  const attachments: Attachment[] = screenshot ? [screenshot] : [];
  if (input.logs?.length)
    attachments.push({ bytes: encoder.encode(JSON.stringify(input.logs)), contentType: "application/json", filename: "logs.json" });
  return postEnvelope(env, envelope(id, "feedback", payload, attachments));
}

/** Capture a fixed error code without serializing an exception, stack, response, or request. */
export async function captureError(
  env: SentryEnv,
  code: string,
  page: string,
  accountId?: string,
  requestId?: string,
): Promise<void> {
  const safeCode = errorCode(code);
  if (!safeCode) return;
  const id = eventId();
  const payload: Record<string, unknown> = {
    event_id: id,
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level: "error",
    message: safeCode,
    fingerprint: ["basalt", safeCode],
    tags: {
      error_code: safeCode, page_template: pageTemplate(page),
      ...(typeof requestId === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)
        ? { request_id: requestId } : {}),
    },
    ...(isAccountId(accountId) ? { user: { id: accountId } } : {}),
  };
  await postEnvelope(env, envelope(id, "event", payload));
}
