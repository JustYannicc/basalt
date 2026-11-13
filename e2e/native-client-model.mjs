/** External model peer, including the private reader protocol selected by a signed assertion. */
export const syntheticTunnelModel = `
export default { fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/native/v1/session") return env.LIFETIME.fetch(request);
  if (request.headers.get("upgrade") === "websocket") {
    const assertion = request.headers.get("x-basalt-native-assertion");
    const claims = assertion && JSON.parse(atob(assertion.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")));
    const drain = claims?.modelDrain === "basalt.model-drain.v1";
    const pair = new WebSocketPair();
    pair[1].binaryType = "arraybuffer";
    pair[1].accept();
    let sequence = 0;
    const send = (message) => {
      if (!drain) { pair[1].send(message); return; }
      const text = typeof message === "string";
      const bytes = text ? new TextEncoder().encode(message) : new Uint8Array(message);
      const frame = new Uint8Array(1 + bytes.length);
      frame[0] = text ? 0 : 1;
      frame.set(bytes, 1);
      pair[1].send(frame.buffer);
    };
    pair[1].addEventListener("message", event => {
      let message = event.data;
      if (drain) {
        const frame = message instanceof ArrayBuffer ? new Uint8Array(message) : undefined;
        if (!frame || frame.length < 5 || frame.length - 5 > 16777216 ||
            (frame[0] !== 0 && frame[0] !== 1) ||
            new DataView(message).getUint32(1) !== sequence + 1) {
          pair[1].close(1008, "Invalid consumer frame"); return;
        }
        sequence++;
        const body = frame.subarray(5);
        message = frame[0] === 0 ? new TextDecoder("utf-8", { fatal: true }).decode(body) : body.slice().buffer;
        const receipt = new Uint8Array(9);
        receipt[0] = 2;
        const view = new DataView(receipt.buffer);
        view.setUint32(1, sequence);
        view.setUint32(5, body.length);
        pair[1].send(receipt.buffer);
      }
      if (message === "request-target") {
        send(JSON.stringify({ path: url.pathname, search: url.search }));
      } else if (message === "close-with-output") {
        send("retained-after-close"); pair[1].close(1000, "Done");
      } else send(message);
    });
    return new Response(null, {
      status: 101, webSocket: pair[0],
      headers: drain ? { "sec-websocket-protocol": "basalt.model-drain.v1" } : {},
    });
  }
  return fetch(new Request(new URL(url.pathname + url.search, env.MODEL_ORIGIN), request));
} };
`;
