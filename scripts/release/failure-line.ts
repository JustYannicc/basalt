import { CHAIN, errorKind, linksOf, readSafely } from "./public-report.ts";

/**
 * A failure as one public line, with the provider's own error code and message when the error
 * carries them (Cloudflare's 1601 IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE, say). The line prints right
 * before the re-point after a failed apply, so nothing here may throw or hang: every read is
 * guarded, the walk is bounded in nodes, depth and items, and any trouble falls back to the
 * class-only line. A message prints only in a shape that cannot carry a host, an address, an id,
 * a path or a page; anything else is left out rather than scrubbed.
 */

const MAX_NODES = 200;
const MAX_QUEUE = 2_000;
const MAX_DEPTH = 8;
const MAX_BODY = 64 * 1024;

// A code name (IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE), or short prose of letters with spaces and
// light punctuation (Container application not found). No digits, dots, slashes, colons, at
// signs or angle brackets, so no host, address, URL, id, digest, path, email or markup.
const CODE_NAME = /^[A-Z][A-Z0-9_]{2,79}$/u;
const PROSE = /^[A-Za-z][A-Za-z ,'()-]{0,118}[A-Za-z)]$/u;

/** The message as the public log may print it, or nothing when its shape could carry more. */
export function publicMessage(text: string): string | undefined {
  if (text.length > 121) return undefined;
  const trimmed = text.trim().replace(/\.$/u, "");
  return CODE_NAME.test(trimmed) || PROSE.test(trimmed) ? trimmed : undefined;
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
export function providerError(error: unknown): { code?: number; message?: string } | undefined {
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
      if (typeof code === "number" && Number.isInteger(code) && code > 0) {
        const shown = publicMessage(message);
        return shown === undefined ? { code } : { code, message: shown };
      }
      const tag = readSafely(value, "_tag");
      if (uncoded === undefined && typeof tag === "string" && STATUS_CLASSES.has(tag))
        uncoded = message;
    }
    const visit = (link: unknown) => {
      for (const item of linksOf(link, 20))
        if (item && typeof item === "object" && !seen.has(item) && queue.length < MAX_QUEUE)
          queue.push([item, depth + 1]);
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
  const message = uncoded === undefined ? undefined : publicMessage(uncoded);
  return message === undefined ? undefined : { message };
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
    const parts = [
      provider?.code === undefined ? undefined : `code ${provider.code}`,
      provider?.message,
    ].filter((part) => part !== undefined);
    return parts.length ? `${line}: ${parts.join(", ")}` : line;
  } catch {
    return line;
  }
}
