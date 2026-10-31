import { Schema } from "effect";

export const tunnelPath = "/native/v1/tunnel";
export const tunnelProtocol = "basalt.tunnel.v1";
export const tunnelLimits = {
  frameBytes: 32_768,
  chunkBytes: 16_384,
  windowBytes: 65_536,
  requestBytes: 16 * 1024 * 1024,
  websocketRequestBytes: 1024 * 1024,
  operations: 16,
  sessionMilliseconds: 10 * 60_000,
} as const;

const Id = Schema.Int.check(Schema.makeFilter((id) => id > 0 && id <= 0x7fff_ffff));
const Header = Schema.String.check(
  Schema.makeFilter((value) => value.length <= 4096 && !/[\r\n\0]/u.test(value)),
);
export const TunnelRequestHeaders = Schema.Struct({
  accept: Schema.optionalKey(Header),
  "content-type": Schema.optionalKey(Header),
  "content-encoding": Schema.optionalKey(Header),
  "mcp-session-id": Schema.optionalKey(Header),
  "mcp-protocol-version": Schema.optionalKey(Header),
  "last-event-id": Schema.optionalKey(Header),
  "anthropic-version": Schema.optionalKey(Header),
  "anthropic-beta": Schema.optionalKey(Header),
  "openai-beta": Schema.optionalKey(Header),
});
export const TunnelResponseHeaders = Schema.Struct({
  "content-type": Schema.optionalKey(Header),
  "content-encoding": Schema.optionalKey(Header),
  "content-length": Schema.optionalKey(Header),
  "cache-control": Schema.optionalKey(Header),
  "mcp-session-id": Schema.optionalKey(Header),
  "mcp-protocol-version": Schema.optionalKey(Header),
  "retry-after": Schema.optionalKey(Header),
  "x-request-id": Schema.optionalKey(Header),
  "request-id": Schema.optionalKey(Header),
});
export const tunnelResponseHeaderNames = Object.keys(TunnelResponseHeaders.fields);
// Consumers can resolve another Effect installation. Decode with the schema's own runtime.
export const decodeTunnelResponseHeaders = Schema.decodeUnknownSync(TunnelResponseHeaders, {
  onExcessProperty: "error",
});

const Operation = Schema.Union([
  Schema.Struct({
    service: Schema.Literal("models"),
    method: Schema.Literal("GET"),
    path: Schema.Literal("/v1/models"),
    transport: Schema.Literal("http"),
  }),
  Schema.Struct({
    service: Schema.Literal("models"),
    method: Schema.Literal("POST"),
    path: Schema.Literals([
      "/v1/responses",
      "/v1/responses/compact",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/messages/count_tokens",
      "/v1/completions",
      "/v1/embeddings",
    ]),
    transport: Schema.Literal("http"),
  }),
  Schema.Struct({
    service: Schema.Literal("models"),
    method: Schema.Literal("GET"),
    path: Schema.Literal("/v1/responses"),
    transport: Schema.Literal("websocket"),
  }),
  Schema.Struct({
    service: Schema.Literal("tools"),
    method: Schema.Literals(["GET", "POST", "DELETE"]),
    path: Schema.Literal("/mcp"),
    transport: Schema.Literal("http"),
  }),
]);
export const TunnelOpen = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("open"),
  id: Id,
  operation: Operation,
  headers: TunnelRequestHeaders,
});
const Bytes = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      value.length > 0 &&
      value.length <= 4 * Math.ceil(tunnelLimits.chunkBytes / 3) &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value),
  ),
);
export const TunnelData = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("data"),
  id: Id,
  bytes: Bytes,
  text: Schema.Boolean,
  more: Schema.optionalKey(Schema.Boolean),
});
export const TunnelCredit = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("credit"),
  id: Id,
  bytes: Schema.Int.check(
    Schema.makeFilter((value) => value > 0 && value <= tunnelLimits.windowBytes),
  ),
});
const terminal = (type: "end" | "cancel") =>
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal(type), id: Id });
export const TunnelClientFrame = Schema.Union([
  TunnelOpen,
  TunnelData,
  TunnelCredit,
  terminal("end"),
  terminal("cancel"),
]);
export type TunnelClientFrame = typeof TunnelClientFrame.Type;
export type TunnelOpen = typeof TunnelOpen.Type;
export type TunnelData = typeof TunnelData.Type;
export type TunnelCredit = typeof TunnelCredit.Type;

export const TunnelServerFrame = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("ready"),
    expiresAt: Schema.Int,
    limits: Schema.Struct({
      frameBytes: Schema.Int,
      chunkBytes: Schema.Int,
      windowBytes: Schema.Int,
      requestBytes: Schema.Int,
      websocketRequestBytes: Schema.Int,
      operations: Schema.Int,
      sessionMilliseconds: Schema.Int,
    }),
  }),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("response"),
    id: Id,
    status: Schema.Int.check(
      Schema.makeFilter((value) => value === 101 || (value >= 200 && value <= 599)),
    ),
    headers: TunnelResponseHeaders,
  }),
  TunnelData,
  TunnelCredit,
  terminal("end"),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("error"),
    id: Id,
    code: Schema.Literals(["refused", "unavailable", "interrupted", "limit"]),
    outcome: Schema.Literals(["not-started", "unknown"]),
  }),
]);
export type TunnelServerFrame = typeof TunnelServerFrame.Type;

const readClient = Schema.decodeUnknownSync(TunnelClientFrame, { onExcessProperty: "error" });
const readServer = Schema.decodeUnknownSync(TunnelServerFrame, { onExcessProperty: "error" });
export function decodeTunnelFrame(value: string, side: "client"): TunnelClientFrame;
export function decodeTunnelFrame(value: string, side: "server"): TunnelServerFrame;
export function decodeTunnelFrame(value: string, side: "client" | "server") {
  if (new TextEncoder().encode(value).length > tunnelLimits.frameBytes)
    throw new Error("Tunnel frame exceeds its limit");
  const parsed: unknown = JSON.parse(value);
  return side === "client" ? readClient(parsed) : readServer(parsed);
}
export const encodeTunnelBytes = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
export function decodeTunnelBytes(value: string): Uint8Array {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (bytes.length > tunnelLimits.chunkBytes || encodeTunnelBytes(bytes) !== value)
    throw new Error("Invalid tunnel bytes");
  return bytes;
}
