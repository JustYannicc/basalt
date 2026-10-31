/** External model peer. Its HTTP boundary preserves the full path and query for assertions. */
export const syntheticTunnelModel = `
export default { fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/native/v1/session") return env.LIFETIME.fetch(request);
  if (request.headers.get("upgrade") === "websocket") {
    const pair = new WebSocketPair();
    pair[1].binaryType = "arraybuffer";
    pair[1].accept();
    pair[1].addEventListener("message", event => {
      if (event.data === "request-target") {
        pair[1].send(JSON.stringify({ path: url.pathname, search: url.search }));
      } else if (event.data === "close-with-output") {
        pair[1].send("retained-after-close"); pair[1].close(1000, "Done");
      } else pair[1].send(event.data);
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  return fetch(new Request(new URL(url.pathname + url.search, env.MODEL_ORIGIN), request));
} };
`;
