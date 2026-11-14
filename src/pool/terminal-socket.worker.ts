import { modelDrainPayload, modelDrainProtocol } from "./model-drain-contract.ts";
import { TerminalJson } from "./terminal-json.ts";
import { protocolOutcome } from "./terminal-protocol.ts";
import type { TerminalFinish } from "./terminal-response.worker.ts";

/** Both ends add the request sequence to the private session UUID's low 48 bits. */
export function socketRequestId(session: string, sequence: number): string {
  const tail = (BigInt(`0x${session.slice(24)}`) + BigInt(sequence)) & 0xffffffffffffn;
  return session.slice(0, 24) + tail.toString(16).padStart(12, "0");
}

function envelope(data: unknown) {
  const json = new TerminalJson();
  let bytes = 0;
  if (typeof data === "string") {
    json.push(data);
    for (let index = 0; index < data.length; index++) {
      const code = data.charCodeAt(index);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        index + 1 < data.length &&
        data.charCodeAt(index + 1) >= 0xdc00 &&
        data.charCodeAt(index + 1) <= 0xdfff
      ) {
        bytes += 4;
        index++;
      } else bytes += 3;
    }
  } else if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    const decoder = new TextDecoder();
    const value = data instanceof Uint8Array ? data : new Uint8Array(data);
    bytes = value.byteLength;
    for (let offset = 0; offset < value.length; offset += 8192)
      json.push(decoder.decode(value.subarray(offset, offset + 8192), { stream: true }));
    json.push(decoder.decode());
  } else return undefined;
  return json.end()
    ? {
        fields: json.fields,
        bytes,
        requestType: json.requestType()?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""),
      }
    : undefined;
}

/** Each Responses create is an attempt. Opening or closing an idle socket is not one. */
export function terminalSocket(
  response: Response,
  session: string,
  start: (requestId: string) => TerminalFinish | undefined,
  acknowledged: boolean,
): Response {
  const upstream = response.webSocket!;
  const framed = response.headers.get("sec-websocket-protocol") === modelDrainProtocol;
  const payload = (data: unknown, direction: "input" | "output") =>
    framed ? modelDrainPayload(data, direction) : data;
  const pair = new WebSocketPair();
  const client = pair[0],
    server = pair[1];
  const pending = new Map<string, { finish: TerminalFinish; response?: string; bytes: number }>();
  let sequence = 0,
    closed = false;
  let active: string | undefined;
  upstream.binaryType = "arraybuffer";
  server.binaryType = "arraybuffer";
  upstream.accept();
  server.accept();
  const close = (
    outcome: "truncated" | "client_closed",
    code = 1011,
    reason = "Connection ended",
  ) => {
    if (closed) return;
    closed = true;
    for (const item of pending.values())
      item.finish(outcome, outcome === "client_closed" ? 499 : 502, item.bytes);
    pending.clear();
    for (const socket of [upstream, server]) {
      try {
        socket.close(
          code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011,
          reason,
        );
      } catch {}
    }
  };
  server.addEventListener("message", (event) => {
    const parsed = envelope(payload(event.data, "input"));
    if (parsed && ["response.create", "response.append"].includes(parsed.requestType ?? "")) {
      if (++sequence >= 2 ** 48) {
        close("client_closed");
        return;
      }
      const id = socketRequestId(session, sequence);
      const finish = start(id);
      if (finish && !acknowledged) finish("unavailable", 101, 0);
      else if (finish) {
        // Evidence tracking must not become an unbounded queue. Lost observation stays explicitly unavailable.
        if (pending.size >= 64) {
          const oldest = pending.keys().next().value!;
          const dropped = pending.get(oldest)!;
          pending.delete(oldest);
          dropped.finish("unavailable", 200, dropped.bytes);
        }
        pending.set(id, { finish, bytes: 0 });
      }
    }
    try {
      upstream.send(event.data);
    } catch {
      close("truncated");
    }
  });
  upstream.addEventListener("message", (event) => {
    const parsed = envelope(payload(event.data, "output"));
    if (parsed?.fields.type === "basalt.request_started") {
      active = pending.has(parsed.fields.request_id ?? "") ? parsed.fields.request_id : undefined;
      return;
    }
    try {
      server.send(event.data);
    } catch {
      close("client_closed");
      return;
    }
    if (!parsed) return;
    const responseId = parsed.fields["response.id"] ?? parsed.fields.response_id;
    let match: [string, { finish: TerminalFinish; response?: string; bytes: number }] | undefined;
    if (responseId) {
      for (const entry of pending) {
        if (entry[1].response === responseId) {
          match = entry;
          break;
        }
      }
    }
    if (!match && active && pending.has(active)) match = [active, pending.get(active)!];
    if (!match) {
      // A missing private join must stay unknown; arrival order cannot identify a skipped frame.
      return;
    }
    const [id, item] = match;
    if (responseId) item.response = responseId;
    item.bytes += parsed.bytes;
    const outcome = protocolOutcome(parsed.fields, "responses");
    if (outcome) {
      pending.delete(id);
      if (active === id) active = undefined;
      item.finish(outcome, 200, item.bytes);
    }
  });
  upstream.addEventListener("close", (event) => close("truncated", event.code, event.reason));
  upstream.addEventListener("error", () => close("truncated"));
  server.addEventListener("close", (event) => close("client_closed", event.code, event.reason));
  server.addEventListener("error", () => close("client_closed"));
  const headers = new Headers(response.headers);
  headers.delete("X-Basalt-Terminal-Protocol");
  headers.delete("X-Basalt-Request-Id");
  return new Response(null, { status: 101, headers, webSocket: client });
}
