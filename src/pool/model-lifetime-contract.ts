export const modelLifetimeProtocol = "basalt.model-lifetime.v1";
export const modelLifetimePath = "/v1/__basalt/model-lifetime";
export const modelLifetimeHeader = "x-basalt-model-lifetime-id";

export const isModelLifetimePath = (pathname: string) =>
  pathname === modelLifetimePath || pathname.startsWith(`${modelLifetimePath}/`);

/** Public requests cannot adopt an internal connection or address its completion socket. */
export function stripModelLifetimeRequest(request: Request) {
  const offered = request.headers.get("Sec-WebSocket-Protocol");
  const protocols = offered?.split(",") ?? [];
  const internal = protocols.some((value) => value.trim() === modelLifetimeProtocol);
  if (!request.headers.has(modelLifetimeHeader) && !internal) return request;
  const headers = new Headers(request.headers);
  headers.delete(modelLifetimeHeader);
  if (internal) {
    const publicProtocols = protocols
      .filter((value) => value.trim() !== modelLifetimeProtocol)
      .join(",");
    if (publicProtocols.trim()) headers.set("Sec-WebSocket-Protocol", publicProtocols);
    else headers.delete("Sec-WebSocket-Protocol");
  }
  return new Request(request, { headers });
}
