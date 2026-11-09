import { eventId, sendEnvelope, type Attachment } from "./sentry-envelope.ts";
import { isAccountId } from "./product.ts";
import { errorCode, pageTemplate, recentErrors } from "./privacy.ts";
import { type SentryEnv, validSentryDsn } from "./sentry-target.ts";

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

const encoder = new TextEncoder();
const screenshotBytesMax = 2 * 1024 * 1024;
const feedbackMessageMax = 4096;

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
    typeof data !== "string" ||
    data.length === 0 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    return null;
  try {
    const decoded = atob(data);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    if (bytes.byteLength > screenshotBytesMax) return null;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if ((contentType === "image/png" && !png) || (contentType === "image/jpeg" && !jpeg))
      return null;
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

/** Send explicit feedback text, an optional bounded screenshot and redacted page logs, with no automatic PII. */
export async function sendFeedback(env: SentryEnv, input: FeedbackInput): Promise<boolean> {
  if (
    !validSentryDsn(env.SENTRY_DSN) ||
    !isAccountId(input.accountId) ||
    typeof input.message !== "string" ||
    !input.message.trim() ||
    !withinFeedbackLimit(input.message)
  )
    return false;
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
    attachments.push({
      bytes: encoder.encode(JSON.stringify(input.logs)),
      contentType: "application/json",
      filename: "logs.json",
    });
  return sendEnvelope(env, { id, type: "feedback", payload, attachments });
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
      error_code: safeCode,
      page_template: pageTemplate(page),
      ...(typeof requestId === "string" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId)
        ? { request_id: requestId }
        : {}),
    },
    ...(isAccountId(accountId) ? { user: { id: accountId } } : {}),
  };
  await sendEnvelope(env, { id, type: "event", payload });
}
