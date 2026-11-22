import { CHAIN, errorKind, linksOf, readSafely } from "./public-report.ts";

/**
 * A failure as one public line, with the provider's own error code and message when the error
 * carries them (Cloudflare's 1601 IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE, say). The line prints right
 * before the re-point after a failed apply, so nothing here may throw or hang: every read is
 * guarded, the walk is bounded in nodes, depth and items, long text is cut before any pattern
 * runs, and any trouble falls back to the class-only line.
 */

const MAX_NODES = 200;
const MAX_DEPTH = 8;
const MAX_BODY = 64 * 1024;
const MAX_SCAN = 2_000;
const MAX_MESSAGE = 200;

/**
 * A provider message as a public log may carry it: one line of at most 200 characters with no URL,
 * host, account or other id, digest, or token-like run. Text past 2,000 characters is never read.
 */
export function publicMessage(text: string): string {
  const redacted = text
    .slice(0, MAX_SCAN)
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "{url}")
    .replace(/\b[a-f0-9]{32}\b/giu, "{id}")
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/giu, "{host}")
    // A long run with a digit is an id, a digest or a token; a code name such as
    // IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE has none and stays.
    .replace(/[A-Za-z0-9_+/=:.-]{24,}/gu, (run) => (/\d/u.test(run) ? "{redacted}" : run))
    .replace(/\s+/gu, " ")
    .trim();
  return redacted.length > MAX_MESSAGE ? `${redacted.slice(0, MAX_MESSAGE)}…` : redacted;
}

// The SDK's HTTP status classes: a 4xx or 5xx that no operation claimed becomes one of these,
// carrying Cloudflare's message but not its code.
const STATUS_CLASSES = new Set([
  "BadRequest",
  "Unauthorized",
  "Forbidden",
  "NotFound",
  "Conflict",
  "UnprocessableEntity",
  "Locked",
  "TooManyRequests",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
]);

/**
 * The provider's own error in an error's chain: a numeric `code` with its `message` (an SDK
 * error's own, an `errors` entry, or a response `body` holding Cloudflare's envelope), else the
 * message of an SDK status class, which keeps no code. Only the code and message are read; an
 * entry's details, which name the registry and the image, never are.
 */
export function providerError(error: unknown): { code?: number; message: string } | undefined {
  const seen = new Set<unknown>();
  const queue: Array<readonly [unknown, number]> = [[error, 0]];
  let uncoded: string | undefined;
  for (let next = 0; next < queue.length && next < MAX_NODES; next++) {
    const [value, depth] = queue[next]!;
    if (!value || typeof value !== "object" || seen.has(value) || depth > MAX_DEPTH) continue;
    seen.add(value);
    const code = readSafely(value, "code");
    const message = readSafely(value, "message");
    if (typeof message === "string") {
      if (typeof code === "number" && Number.isInteger(code) && code > 0)
        return { code, message: publicMessage(message) };
      const tag = readSafely(value, "_tag");
      if (uncoded === undefined && typeof tag === "string" && STATUS_CLASSES.has(tag))
        uncoded = message;
    }
    const visit = (link: unknown) => {
      for (const item of linksOf(link, 20)) queue.push([item, depth + 1]);
    };
    visit(readSafely(value, "errors"));
    const body = readSafely(value, "body");
    if (typeof body === "string" && body.length <= MAX_BODY)
      try {
        visit(JSON.parse(body));
      } catch {
        // Not a JSON envelope: nothing to read from it.
      }
    for (const key of CHAIN) visit(readSafely(value, key));
  }
  return uncoded === undefined ? undefined : { message: publicMessage(uncoded) };
}

/** An error's kind as one public line: its class and kind, and the HTTP status when it has one. */
export const errorLine = (kind: { errorClass: string; kind: string; status?: number }) =>
  `${kind.errorClass} (${kind.kind}${kind.status === undefined ? "" : `, HTTP ${kind.status}`})`;

/** The class-only line, then the provider's code and message when the error carries them. */
export function failureLine(error: unknown): string {
  let line: string;
  try {
    line = errorLine(errorKind(error));
  } catch {
    return "an error that could not be read";
  }
  try {
    const provider = providerError(error);
    if (!provider) return line;
    return `${line}: ${provider.code === undefined ? "" : `code ${provider.code}, `}${provider.message}`;
  } catch {
    return line;
  }
}
