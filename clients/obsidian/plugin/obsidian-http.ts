import { requestUrl, type RequestUrlParam } from "obsidian";
import type { Http } from "../http.ts";

/**
 * requestUrl is Obsidian's cross-platform HTTP path (desktop and mobile, no CORS).
 * `throw: false` hands every status back so auth.ts and remote.ts keep their own error mapping.
 */
export const obsidianHttp: Http = async (url, init) => {
  const request: RequestUrlParam = { url, method: init.method, throw: false };
  if (init.headers) request.headers = init.headers;
  if (init.body !== undefined) request.body = init.body;
  const reply = await requestUrl(request);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(reply.headers)) headers[name.toLowerCase()] = value;
  return { status: reply.status, headers, body: reply.text };
};
