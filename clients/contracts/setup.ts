import { Schema } from "effect";

const AgentChoice = Schema.Literals(["connect", "keep", "undo"]);
export const AgentSelection = Schema.Struct({ claude: AgentChoice, codex: AgentChoice });
export type AgentSelection = typeof AgentSelection.Type;
export const SetupPreview = Schema.Struct({
  id: Schema.NonEmptyString,
  files: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      path: Schema.String,
      action: Schema.Literals(["update", "restore", "keep"]),
      fields: Schema.Array(Schema.String),
    }),
  ),
});
export type SetupPreview = typeof SetupPreview.Type;
export const readAgentSelection = Schema.decodeUnknownSync(AgentSelection, {
  onExcessProperty: "error",
});
