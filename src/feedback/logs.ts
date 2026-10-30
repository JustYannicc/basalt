import { exact, object, TelemetryInputError } from "../telemetry/http.ts";
import { feedbackLimits } from "./ui.ts";

/** One console error or one failed request from the page. Status 0 means no response came. */
export type FeedbackLogEntry =
  | { kind: "error"; at: string; message: string }
  | { kind: "request"; at: string; method: string; path: string; crossOrigin?: true; status: number; durationMs: number };

/**
 * The dashboard redacts logs as it records them (patch 0047). This repeats it, so a modified or
 * older page can't send a token, address or query string through. The rules match the page's;
 * scripts/upstream-tests/feedback-redaction.test.ts keeps them in step.
 */
const secrets: ReadonlyArray<readonly [RegExp, (match: string, name?: string) => string]> = [
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\b["']?\s*[:=]\s*[^\n]*/gi, (_, name) => `${name}: [redacted]`],
  [
    /\b(password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b["']?\s*[:=]\s*["']?[^\s"'&,;}]+/gi,
    (_, name) => `${name}=[redacted]`,
  ],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, (_, name) => `${name} [redacted]`],
  [/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, () => "[jwt]"],
  [/\b(?:sk|pk|rk|sb|ghp|gho|ghu|ghs|ghr|glpat|github_pat|xox[abprs])[-_][\w-]{8,}/gi, () => "[key]"],
  [/[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+\.[a-z]{2,}/gi, () => "[email]"],
  [/[\w.+-]+%40[\w.-]+\.[a-z]{2,}/gi, () => "[email]"],
  [/\b[0-9a-f]{32,}\b/gi, () => "[hex]"],
  [/[\w+-]{32,}={0,2}/g, (match) => (/\d/.test(match) && /[a-z]/i.test(match) ? "[token]" : match)],
  [/[A-Za-z\d+/]{40,}={0,2}/g, (match) => (/\d/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match) ? "[token]" : match)],
];
const queries = /((?:[a-z][a-z\d+.-]*:)?\/\/[^\s?#"'<>]+|\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;

export function redactLogText(text: string): string {
  return secrets.reduce((result, [pattern, replace]) => result.replace(pattern, replace), text.replace(queries, "$1"));
}

const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const text = (value: unknown, max: number) => {
  if (typeof value !== "string" || value.length > max) throw new TelemetryInputError(400);
  return value;
};
const whole = (value: unknown, max: number) => {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) throw new TelemetryInputError(400);
  return value as number;
};

function entry(value: unknown): FeedbackLogEntry {
  const item = object(value);
  if (typeof item.at !== "string" || !timestamp.test(item.at)) throw new TelemetryInputError(400);
  if (item.kind === "error") {
    exact(item, ["kind", "at", "message"]);
    return { kind: "error", at: item.at, message: redactLogText(text(item.message, feedbackLimits.logMessageMax)) };
  }
  if (item.kind !== "request") throw new TelemetryInputError(400);
  exact(item, item.crossOrigin === undefined
    ? ["kind", "at", "method", "path", "status", "durationMs"]
    : ["kind", "at", "method", "path", "crossOrigin", "status", "durationMs"]);
  const method = text(item.method, 10);
  const path = text(item.path, feedbackLimits.logPathMax);
  if (!/^[A-Z]+$/.test(method) || !path.startsWith("/") || (item.crossOrigin !== undefined && item.crossOrigin !== true))
    throw new TelemetryInputError(400);
  return {
    kind: "request", at: item.at, method, path: redactLogText(path),
    ...(item.crossOrigin === true ? { crossOrigin: true as const } : {}),
    status: whole(item.status, 599), durationMs: whole(item.durationMs, 3_600_000),
  };
}

/**
 * The optional logs attachment: at most `logEntriesMax` entries and `logBytesMax` bytes as JSON,
 * each entry exactly an error or a request, with its text redacted again. An entry that isn't is
 * left out rather than failing the feedback it came with.
 */
export function feedbackLogs(value: unknown): FeedbackLogEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TelemetryInputError(400);
  if (value.length > feedbackLimits.logEntriesMax || new TextEncoder().encode(JSON.stringify(value)).byteLength > feedbackLimits.logBytesMax)
    throw new TelemetryInputError(413);
  return value.flatMap((item) => {
    try {
      return [entry(item)];
    } catch (error) {
      if (error instanceof TelemetryInputError) return [];
      throw error;
    }
  });
}
