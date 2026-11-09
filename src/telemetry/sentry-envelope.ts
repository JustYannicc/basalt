import { sentryEnvelopeTarget, type SentryEnv } from "./sentry-target.ts";

export interface Attachment {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/jpeg" | "application/json";
  readonly filename: "screenshot.png" | "screenshot.jpg" | "logs.json";
}

const encoder = new TextEncoder();
const timeoutMs = 3000;

export function eventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  type: "event" | "feedback" | "check_in",
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
    append(
      parts,
      `${JSON.stringify({
        type: "attachment",
        length: attachment.bytes.byteLength,
        filename: attachment.filename,
        content_type: attachment.contentType,
        attachment_type: "event.attachment",
      })}\n`,
    );
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

export async function sendEnvelope(
  env: SentryEnv,
  input: {
    id: string;
    type: "event" | "feedback" | "check_in";
    payload: Record<string, unknown>;
    attachments?: readonly Attachment[];
  },
): Promise<boolean> {
  return postEnvelope(env, envelope(input.id, input.type, input.payload, input.attachments));
}
