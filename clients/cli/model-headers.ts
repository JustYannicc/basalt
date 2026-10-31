import type { IncomingMessage } from "node:http";

/** Codex uses its local key beside its existing provider login. Replace only the local key. */
export function modelHeaders(request: IncomingMessage, token: string) {
  const headers: Record<string, string> = {};
  if (request.headers["x-api-key"] !== undefined) {
    const authorization = request.headers.authorization;
    headers["x-api-key"] = token;
    if (authorization && authorization !== `Bearer ${request.headers["x-api-key"]}`)
      headers.authorization = authorization;
  } else headers.authorization = `Bearer ${token}`;
  return headers;
}
