import { Schema } from "effect";
import { ConnectionView, Origin } from "../contracts/connection.ts";
import { AgentSelection, SetupPreview } from "../contracts/setup.ts";
export type { AgentSelection, SetupPreview } from "../contracts/setup.ts";
export const DesktopRequest = Schema.Union([
  Schema.Struct({
    action: Schema.Literals([
      "status",
      "cancel-sign-in",
      "open-approval",
      "disconnect",
      "reconnect",
      "sign-out",
      "revoke",
      "undo-preview",
      "cancel-preview",
      "import-direct",
    ]),
  }),
  Schema.Struct({ action: Schema.Literal("sign-in"), origin: Origin }),
  Schema.Struct({ action: Schema.Literal("setup-preview"), selection: AgentSelection }),
  Schema.Struct({ action: Schema.Literal("setup-apply"), id: Schema.NonEmptyString }),
]);
export type DesktopRequest = typeof DesktopRequest.Type;
export const readDesktopRequest = Schema.decodeUnknownSync(DesktopRequest, {
  onExcessProperty: "error",
});
export const DesktopSnapshot = Schema.Struct({
  connection: Schema.optionalKey(ConnectionView),
  phase: Schema.Literals(["starting", "ready", "signing-in"]),
  configured: Schema.Struct({ claude: Schema.Boolean, codex: Schema.Boolean }),
  canReconnect: Schema.Boolean,
  localOrigin: Schema.optionalKey(Schema.String),
  authorization: Schema.optionalKey(Schema.Struct({ url: Schema.String, code: Schema.String })),
  error: Schema.optionalKey(Schema.String),
});
export type DesktopSnapshot = typeof DesktopSnapshot.Type;
export const DesktopReply = Schema.Struct({
  snapshot: DesktopSnapshot,
  preview: Schema.optionalKey(SetupPreview),
});
export type DesktopReply = typeof DesktopReply.Type;
export const readDesktopReply = Schema.decodeUnknownSync(DesktopReply);

export interface DesktopApi {
  request(value: DesktopRequest): Promise<DesktopReply>;
}
