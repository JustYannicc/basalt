import { Schema } from "effect";

export const tunnelPath = "/native/v1/tunnel";
export const tunnelProtocol = "basalt.tunnel.v1";
export const tunnelMessageProtocol = "basalt.tunnel.v2";
export const maximumModelSearchLength = 2048;

/** Search is data on an allowed model path, never a second URL or routing instruction. */
export function normalizeModelSearch(value: string): string {
  if (
    value.length > maximumModelSearchLength ||
    !value.startsWith("?") ||
    // oxlint-disable-next-line no-control-regex -- URL routing rejects raw control characters.
    /[#\\\u0000-\u0020\u007f]/u.test(value)
  )
    throw new Error("Invalid model search.");
  // URLSearchParams tolerates broken percent encoding; reject it before that lossy parse.
  decodeURIComponent(value.slice(1).replaceAll("+", " "));
  const parameters = new URLSearchParams(value.slice(1));
  if (!parameters.size) throw new Error("Empty model search.");
  for (const [name, item] of parameters)
    // oxlint-disable-next-line no-control-regex -- Percent-decoded controls must not enter a model URL.
    if (!/^[a-zA-Z0-9_.~-]+$/u.test(name) || /[#\\\u0000-\u001f\u007f]/u.test(item))
      throw new Error("Invalid model search parameter.");
  const normalized = `?${parameters.toString()}`;
  if (normalized.length > maximumModelSearchLength) throw new Error("Model search is too large.");
  return normalized;
}
const ModelSearch = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      normalizeModelSearch(value);
      return true;
    } catch {
      return false;
    }
  }),
);
// A device budget may wait sixty seconds before admitting a read.
export const nativeTunnelReadyTimeoutMs = 90_000;

export const tunnelLimits = {
  frameBytes: 32_768,
  chunkBytes: 16_384,
  windowBytes: 65_536,
  requestBytes: 16 * 1024 * 1024,
  websocketRequestBytes: 1024 * 1024,
  operations: 16,
  sessionMilliseconds: 10 * 60_000,
} as const;
export const tunnelMessageLimits = {
  ...tunnelLimits,
  websocketMessageBytes: 16 * 1024 * 1024,
} as const;
export type TunnelLimits = typeof tunnelLimits & { readonly websocketMessageBytes?: number };

const Id = Schema.Int.check(Schema.makeFilter((id) => id > 0 && id <= 0x7fff_ffff));
const Header = Schema.String.check(
  Schema.makeFilter((value) => value.length <= 4096 && !/[\r\n\0]/u.test(value)),
);
/** Enough for any real client's product tokens, and small enough to log. */
export const maximumUserAgentLength = 512;
/** MCP routing headers (`mcp-method`, `mcp-name`, `mcp-param-*`) per frame, fixed ones included. */
export const maximumMcpHeaders = 32;
const UserAgent = Header.check(
  Schema.makeFilter((value) => value.length <= maximumUserAgentLength),
);
// MCP names its headers under one prefix and adds more per revision, so the tunnel admits the
// prefix rather than a list. Names must already be lowercase, as Node and fetch hand them over;
// any other spelling stays an unknown key and refuses the frame.
export const mcpHeaderName = /^mcp-[a-z0-9!#$%&'*+.^_`|~-]+$/u;
const McpHeaders = Schema.Record(
  Schema.TemplateLiteral(["mcp-", Schema.String]).check(Schema.isPattern(mcpHeaderName)),
  Header,
);
const mcpHeaderLimit = Schema.makeFilter(
  (headers: object) =>
    Object.keys(headers).filter((key) => key.startsWith("mcp-")).length <= maximumMcpHeaders,
);
const requestHeaderFields = Schema.Struct({
  accept: Schema.optionalKey(Header),
  "content-type": Schema.optionalKey(Header),
  "content-encoding": Schema.optionalKey(Header),
  "mcp-session-id": Schema.optionalKey(Header),
  "mcp-protocol-version": Schema.optionalKey(Header),
  "last-event-id": Schema.optionalKey(Header),
  "anthropic-version": Schema.optionalKey(Header),
  "anthropic-beta": Schema.optionalKey(Header),
  "openai-beta": Schema.optionalKey(Header),
  "user-agent": Schema.optionalKey(UserAgent),
});
export const TunnelRequestHeaders = Schema.StructWithRest(requestHeaderFields, [McpHeaders]).check(
  mcpHeaderLimit,
);
export const tunnelRequestHeaderNames: readonly string[] = Object.keys(requestHeaderFields.fields);
export const decodeTunnelRequestHeaders = Schema.decodeUnknownSync(TunnelRequestHeaders, {
  onExcessProperty: "error",
});
const responseHeaderFields = Schema.Struct({
  "content-type": Schema.optionalKey(Header),
  "content-encoding": Schema.optionalKey(Header),
  "content-length": Schema.optionalKey(Header),
  "cache-control": Schema.optionalKey(Header),
  "mcp-session-id": Schema.optionalKey(Header),
  "mcp-protocol-version": Schema.optionalKey(Header),
  "retry-after": Schema.optionalKey(Header),
  "x-should-retry": Schema.optionalKey(Header),
  "x-request-id": Schema.optionalKey(Header),
  "request-id": Schema.optionalKey(Header),
});
// Decoders ship before emitters: installed clients refuse any response header key they do not
// know, so the server keeps emitting only the fixed names until clients that accept `mcp-*` are
// out. Emission is the fixed list below, never the prefix.
export const TunnelResponseHeaders = Schema.StructWithRest(responseHeaderFields, [
  McpHeaders,
]).check(mcpHeaderLimit);
export const tunnelResponseHeaderNames = Object.keys(responseHeaderFields.fields);
// Consumers can resolve another Effect installation. Decode with the schema's own runtime.
export const decodeTunnelResponseHeaders = Schema.decodeUnknownSync(TunnelResponseHeaders, {
  onExcessProperty: "error",
});

const Operation = Schema.Union([
  Schema.Struct({
    service: Schema.Literal("models"),
    method: Schema.Literal("GET"),
    path: Schema.Literal("/v1/models"),
    search: Schema.optionalKey(ModelSearch),
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
    search: Schema.optionalKey(ModelSearch),
    transport: Schema.Literal("http"),
  }),
  Schema.Struct({
    service: Schema.Literal("models"),
    method: Schema.Literal("GET"),
    path: Schema.Literal("/v1/responses"),
    search: Schema.optionalKey(ModelSearch),
    transport: Schema.Literal("websocket"),
  }),
  Schema.Struct({
    service: Schema.Literal("tools"),
    method: Schema.Literals(["GET", "POST", "DELETE"]),
    path: Schema.Literal("/mcp"),
    transport: Schema.Literal("http"),
  }),
]);
/**
 * `user-agent` and the `mcp-*` names beyond the fixed two belong to MCP traffic. A model call keeps
 * the fixed set it always had: the pool's model proxy reads a client's user agent.
 */
export const toolsOnlyHeader = (key: string) =>
  key === "user-agent" ||
  (key.startsWith("mcp-") && !Object.hasOwn(requestHeaderFields.fields, key));
export const TunnelOpen = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("open"),
  id: Id,
  operation: Operation,
  headers: TunnelRequestHeaders,
}).check(
  Schema.makeFilter(
    (open: { readonly operation: { readonly service: string }; readonly headers: object }) =>
      open.operation.service === "tools" || !Object.keys(open.headers).some(toolsOnlyHeader),
  ),
);
const Bytes = Schema.String.check(
  Schema.makeFilter(
    (value) =>
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
      websocketMessageBytes: Schema.optionalKey(Schema.Int),
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
