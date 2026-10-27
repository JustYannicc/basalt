/**
 * Containers accept only plain HTTP on their ports; the platform already secures that hop. The public
 * request keeps its method, headers, body, path and query, and only its scheme and host change.
 */
export function containerRequest(request: Request): Request {
  const url = new URL(request.url);
  return new Request(new URL(`${url.pathname}${url.search}`, "http://pool"), request);
}
