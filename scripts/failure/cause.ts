import { publicGuidance, publicText } from "./redact.ts";

/**
 * What caused a failure, in a form that may be printed. Provider messages, bodies, URLs and stacks
 * can contain credentials, so only closed diagnostics are copied: a type name of a known shape, an
 * allowlisted code, the HTTP client's reason and status, a provider's numeric codes, and the
 * request's method and identifier-free path.
 */
export interface PublicCause {
  type: string;
  reason?: string;
  status?: number;
  code?: string;
  /** A provider's own numeric error codes. */
  codes?: number[];
  request?: { method: string; path: string };
  message?: string;
}

// Names of errors that do not end the way this repository's own do.
const knownTypes = new Set([
  "Error",
  "WorkerNotFound",
  "WorkerVersionNotFound",
  "NoSuchBucket",
  "CloudflareRateLimited",
  "BadRequest",
  "Unauthorized",
  "Forbidden",
  "NotFound",
  "Conflict",
  "UnprocessableEntity",
  "Locked",
  "TooManyRequests",
  "BadGateway",
]);
// Every other error class: letters only, with an ending no credential has.
const ownType =
  /^[A-Z][A-Za-z]{2,63}(?:Error|Refused|Refusal|Failure|Failed|Unavailable|Possible|Timeout)$/;
/** A request with one of these never left: nothing changed at the service, under Node or Bun. */
export const neverSent = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);
/** The connection broke or went silent after the request may have been sent. */
export const interrupted = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ConnectionClosed",
]);
/** fetch refused the request's own arguments, so nothing was sent. */
export const badArguments = new Set([
  "ERR_INVALID_ARG_VALUE",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_URL",
]);
const codes = new Set([
  ...neverSent,
  ...interrupted,
  ...badArguments,
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "ENOENT",
  "EACCES",
  "EPERM",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const httpReasons = new Set([
  "TransportError",
  "EncodeError",
  "InvalidUrlError",
  "StatusCodeError",
  "DecodeError",
  "EmptyBodyError",
]);
const httpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// API collection words: the segment after one is always an identifier.
const idAfter = new Set([
  "accounts",
  "scripts",
  "buckets",
  "database",
  "databases",
  "organizations",
  "branches",
  "backups",
  "versions",
  "deployments",
  "namespaces",
  "workflows",
  "instances",
  "applications",
  "rollouts",
  "secrets",
  "objects",
]);
// Words that may print as themselves outside an identifier position; anything else is "{id}".
const staticSegments = new Set([
  ...idAfter,
  "client",
  "v1",
  "v2",
  "v4",
  "workers",
  "settings",
  "script-settings",
  "content",
  "subdomain",
  "r2",
  "d1",
  "query",
  "containers",
  "durable_objects",
]);

export const field = (value: unknown, key: string): unknown => {
  try {
    return (typeof value === "object" || typeof value === "function") && value !== null
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Method and path shape only: no origin, query or identifier ever leaves. */
function requestShape(request: unknown): { method: string; path: string } | undefined {
  const method = field(request, "method");
  const url = field(request, "url");
  if (typeof method !== "string" || !httpMethods.has(method) || typeof url !== "string") return;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return;
  }
  // Walk the templated output so an identifier never counts as a collection word.
  const out: string[] = [];
  for (const segment of pathname.split("/")) {
    const previous = out.at(-1) ?? "";
    // `/workers/workers/{id}` is the beta API's collection; `/workers/scripts` is not.
    const collection =
      idAfter.has(previous) || (previous === "workers" && out.at(-2) === "workers");
    out.push(!segment || (!collection && staticSegments.has(segment)) ? segment : "{id}");
  }
  return { method, path: out.join("/").slice(0, 256) };
}

export function typeName(error: unknown): string {
  for (const key of ["_tag", "name"]) {
    const value = field(error, key);
    if (typeof value === "string" && (knownTypes.has(value) || ownType.test(value))) return value;
  }
  const constructor = field(field(error, "constructor"), "name");
  return typeof constructor === "string" &&
    (knownTypes.has(constructor) || ownType.test(constructor))
    ? constructor
    : "unknown";
}

function publicCause(error: unknown, environment: NodeJS.ProcessEnv): PublicCause {
  const type = typeName(error);
  const httpReason = type === "HttpClientError" ? field(error, "reason") : undefined;
  const reason = field(httpReason, "_tag");
  // A failed command also has a `status`: its exit code.
  const exited = field(error, "pid") !== undefined || field(error, "spawnargs") !== undefined;
  const status =
    (exited ? undefined : field(error, "status")) ??
    field(field(httpReason, "response"), "status") ??
    field(field(error, "http"), "status");
  const code = field(error, "code");
  const entries = field(error, "errors");
  const numbers = [
    code,
    ...(Array.isArray(entries) ? entries.slice(0, 8) : []).map((entry) => field(entry, "code")),
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
  );
  const request = requestShape(field(httpReason, "request") ?? field(error, "request"));
  const why = field(error, "why");
  const message = field(error, "message");
  return {
    type,
    ...(typeof reason === "string" && httpReasons.has(reason) ? { reason } : {}),
    ...(typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599
      ? { status }
      : {}),
    ...(typeof code === "string" && codes.has(code) ? { code } : {}),
    ...(numbers.length ? { codes: [...new Set(numbers)] } : {}),
    ...(request ? { request } : {}),
    // A refusal's own reason is written for the log. Of the rest only fetch's TypeErrors explain a
    // failure without quoting a response; parser and server messages can carry bodies.
    ...(typeof why === "string"
      ? { message: publicGuidance(why, environment) }
      : error instanceof TypeError && typeof message === "string"
        ? { message: publicText(message, environment) }
        : {}),
  };
}

/** The failures a collection holds. */
export function members(error: unknown): unknown[] {
  const errors = field(error, "errors");
  return Array.isArray(errors) ? errors.filter((entry) => entry instanceof Error) : [];
}

/** What a failure wraps. Effect's HTTP client keeps fetch's error under its reason. */
const wrapped = (error: unknown): unknown =>
  field(field(error, "reason"), "cause") ??
  field(error, "cause") ??
  field(error, "error") ??
  field(error, "defect");

/** The failure and what it wraps, outermost first. A collection is followed through its first member. */
export function rawChain(error: unknown): unknown[] {
  const found: unknown[] = [];
  for (
    let current = error;
    current !== undefined && current !== null && found.length < 10 && !found.includes(current);
    current = wrapped(current) ?? members(current)[0]
  )
    found.push(current);
  return found;
}

/** Every failure reachable from one, outermost first: what each wraps and each member of a collection. */
export function reach(error: unknown): unknown[] {
  const found: unknown[] = [];
  const queue = [error];
  while (queue.length > 0 && found.length < 64) {
    const current = queue.shift();
    if (current === undefined || current === null || found.includes(current)) continue;
    found.push(current);
    queue.push(wrapped(current), ...members(current));
  }
  return found;
}

/** The same chain as what may be printed of each level. */
export const causeChain = (
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): PublicCause[] =>
  rawChain(error)
    .slice(0, 6)
    .map((entry) => publicCause(entry, environment));

export const causeLine = (cause: PublicCause) =>
  [
    [cause.type, cause.reason, cause.code].filter(Boolean).join(" "),
    cause.status === undefined ? undefined : `HTTP ${cause.status}`,
    cause.codes ? `provider code ${cause.codes.join(", ")}` : undefined,
    cause.request ? `${cause.request.method} ${cause.request.path}` : undefined,
    cause.message,
  ]
    .filter(Boolean)
    .join(": ");

/** Rebuilt from public causes, so nothing that prints the error can reach the original text. */
export function publicError(causes: PublicCause[]): { cause?: Error } {
  let inner: Error | undefined;
  for (const cause of causes.toReversed()) {
    inner = new Error(causeLine(cause), inner ? { cause: inner } : {});
    inner.name = cause.type;
    delete inner.stack;
  }
  return inner ? { cause: inner } : {};
}
