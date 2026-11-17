import { redactFailureOutput } from "../deploy-safety/failure-output.ts";

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

function redact(text: string, secrets: readonly string[]) {
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[redacted]");
  return (
    redactFailureOutput(text, process.env)
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/giu, "[redacted-url]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[redacted-email]")
      .replace(
        /\b(?:(?:module|script)\s+)?source(?:\s+code)?\s*[:=][\s\S]*$/iu,
        "[redacted-source]",
      )
      .replace(/`[^`]*`|"[^"\r\n]*"|'[^'\r\n]*'/gu, "[redacted]")
      .replace(/(?:[A-Za-z]:\\|(?:file:\/\/)?\/)[^\s<>"'`]+/gu, "[redacted-path]")
      .replace(/^\s*(?:at\s|\d+\s*\||export\s|import\s).*$/gmu, "[redacted-source]")
      // eslint-disable-next-line no-control-regex -- Refusal excerpts must not retain terminal control characters.
      .replace(/[\u0000-\u001f\u007f]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

/** Only Cloudflare's error entries become a JSON excerpt; bindings and arbitrary response fields never do. */
export function uploadDiagnosticText(body: unknown, secrets: readonly string[]) {
  let decoded = body;
  if (typeof body === "string" && body.length <= 65_536) {
    try {
      decoded = JSON.parse(body);
    } catch {
      /* The body class distinguishes non-JSON refusals. */
    }
  }
  const entries = field(decoded, "errors");
  const errors = Array.isArray(entries) ? entries.slice(0, 8) : [];
  const messages = errors.flatMap((entry) => {
    const message = field(entry, "message");
    return typeof message === "string" ? [redact(message, secrets).slice(0, 512)] : [];
  });
  const top = field(decoded, "message");
  if (typeof top === "string") messages.push(redact(top, secrets).slice(0, 512));
  const message = messages.join("; ").slice(0, 512);
  if (errors.length)
    return {
      decoded,
      bodyClass: "cloudflare-errors-json" as const,
      message,
      bodyExcerpt: JSON.stringify({
        errors: errors.map((entry) => ({
          code: typeof field(entry, "code") === "number" ? field(entry, "code") : null,
          message:
            typeof field(entry, "message") === "string"
              ? redact(String(field(entry, "message")), secrets).slice(0, 512)
              : "[unavailable]",
        })),
      }).slice(0, 1024),
    };
  if (typeof decoded === "object" && decoded !== null)
    return { decoded, bodyClass: "json" as const, message, bodyExcerpt: message };
  if (typeof body === "string") {
    const html = /<!doctype\s+html|<html\b/iu.test(body);
    const text = html
      ? body
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "[redacted-source]")
          .replace(/<[^>]*>/gu, " ")
      : body;
    return {
      decoded,
      bodyClass: body.trim() ? (html ? ("html" as const) : ("text" as const)) : ("empty" as const),
      message,
      bodyExcerpt: redact(text, secrets).slice(0, 1024),
    };
  }
  return { decoded, bodyClass: "unreadable" as const, message, bodyExcerpt: "" };
}
