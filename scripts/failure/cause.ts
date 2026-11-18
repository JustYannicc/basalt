import { publicText } from "./redact.ts";

/**
 * What caused a failure, in a form that may be printed. Provider messages, bodies, URLs and stacks
 * can contain credentials, so only closed diagnostics are copied: a known type, an allowlisted
 * code, the HTTP client's reason and status, and the request's method and identifier-free path.
 */
export interface PublicCause {
  type: string;
  reason?: string;
  status?: number;
  code?: string;
  request?: { method: string; path: string };
  message?: string;
}

const knownTypes = new Set([
  "TimeoutError",
  "AbortError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AggregateError",
  "Error",
  "HttpClientError",
  "RequestError",
  "ResponseError",
  "SchemaError",
  "ConfigError",
  "StateStoreError",
  "CloudflareHttpError",
  "CloudflareParseError",
  "CloudflareRateLimited",
  "UnknownCloudflareError",
  "SocketError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "RequestAbortedError",
]);
// A class this repository names: letters only, with a suffix no credential ends in.
const ownType =
  /^[A-Z][A-Za-z]{2,63}(?:Error|Refused|Refusal|Failure|Failed|Unavailable|Possible|Timeout)$/;
const codes = new Set([
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
/** Codes of a request that never reached the service: a rerun can succeed. */
export const unreachable = new Set(
  [...codes].filter((code) => !/MODULE|ENOENT|EACCES|EPERM|CERT|SIGNATURE/.test(code)),
);
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
export function requestShape(request: unknown): { method: string; path: string } | undefined {
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
    out.push(
      !segment || (!idAfter.has(previous) && staticSegments.has(segment)) ? segment : "{id}",
    );
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
  const status = field(error, "status") ?? field(field(httpReason, "response"), "status");
  const code = field(error, "code");
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
    ...(request ? { request } : {}),
    // A refusal's own reason is written for the log. Of the rest only fetch's TypeErrors explain a
    // failure without quoting a response; parser and server messages can carry bodies.
    ...(typeof why === "string"
      ? { message: publicText(why, environment) }
      : error instanceof TypeError && typeof message === "string"
        ? { message: publicText(message, environment) }
        : {}),
  };
}

/** The failure and what it wrapped, outermost first. */
export function causeChain(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): PublicCause[] {
  const chain: PublicCause[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && chain.length < 6 && !seen.has(current)) {
    seen.add(current);
    chain.push(publicCause(current, environment));
    // Effect's HTTP client keeps fetch's own error under its reason.
    current = field(field(current, "reason"), "cause") ?? field(current, "cause");
  }
  return chain;
}

export const causeLine = (cause: PublicCause) =>
  [
    [cause.type, cause.reason, cause.code].filter(Boolean).join(" "),
    cause.status === undefined ? undefined : `HTTP ${cause.status}`,
    cause.request ? `${cause.request.method} ${cause.request.path}` : undefined,
    cause.message,
  ]
    .filter(Boolean)
    .join(": ");
