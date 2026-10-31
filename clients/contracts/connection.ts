import { Schema } from "effect";
import type { ClientOperation, OpenOperation } from "./transport.ts";

export const Capability = Schema.Literals(["models", "tools"]);
export type Capability = typeof Capability.Type;
const Token = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => value.length <= 16_384 && !/\s/u.test(value)),
);
export const Origin = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return (
      url !== null &&
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
            url.hostname.endsWith(".localhost"))))
    );
  }),
);
const Service = Schema.Struct({ origin: Origin, token: Token });
const ToolsService = Schema.Struct({
  origin: Origin,
  path: Schema.String.check(
    Schema.makeFilter((value) => /^\/(?:org\/[^/?#]+\/)?mcp$/u.test(value)),
  ),
  token: Token,
});

/** Direct keys never imply a native device grant or a renewable sign-in. */
export const DirectCredentials = Schema.Struct({
  version: Schema.Literal(1),
  mode: Schema.Literal("direct"),
  models: Schema.optionalKey(Service),
  tools: Schema.optionalKey(ToolsService),
}).check(
  Schema.makeFilter((value) => value.models !== undefined || value.tools !== undefined),
  Schema.makeFilter((value) => value.tools === undefined || value.tools.token.startsWith("ext_")),
);
export type DirectCredentials = typeof DirectCredentials.Type;
export const readDirectCredentials = Schema.decodeUnknownSync(DirectCredentials, {
  onExcessProperty: "error",
});

export const Agent = Schema.Struct({
  id: Schema.String.check(Schema.makeFilter((value) => /^[a-zA-Z0-9_-]{1,80}$/u.test(value))),
  name: Schema.NonEmptyString.check(Schema.makeFilter((value) => value.length <= 80)),
  tokenHash: Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{64}$/u.test(value))),
  capabilities: Schema.Array(Capability),
});
export type Agent = typeof Agent.Type;
export const Profile = Schema.Struct({
  version: Schema.Literal(1),
  storage: Schema.Literals(["os", "file"]),
  port: Schema.Int.check(Schema.makeFilter((value) => value >= 0 && value <= 65535)),
  agents: Schema.Array(Agent),
});
export type Profile = typeof Profile.Type;
export const readProfile = Schema.decodeUnknownSync(Profile, { onExcessProperty: "error" });

export interface ServiceCredentials {
  readonly models?: typeof Service.Type;
  readonly tools?: typeof ToolsService.Type;
}
export const ConnectionView = Schema.Struct({
  state: Schema.Literals(["connected", "disconnected", "sign-in-required", "revoked"]),
  mode: Schema.Literals(["direct", "device"]),
  capabilities: Schema.Array(Capability),
});
export type ConnectionView = typeof ConnectionView.Type;
export const readConnectionView = Schema.decodeUnknownSync(ConnectionView, {
  onExcessProperty: "error",
});

/** The process owns forwarding; a credential source owns renewal and server-side revocation. */
export interface CredentialSource {
  view(): ConnectionView;
  transport(signal: AbortSignal): Promise<ConnectionTransport>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  signOut(): Promise<void>;
  revoke(): Promise<void>;
}
export type ConnectionTransport =
  | { mode: "direct"; credentials: ServiceCredentials }
  | {
      mode: "device";
      capabilities: readonly Capability[];
      open(request: OpenOperation, signal: AbortSignal): ClientOperation;
    };
