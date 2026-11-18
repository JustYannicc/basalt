import { Schema } from "effect";
import { ControllerCode, SlotIdentity, SlotRefused } from "./runtime-slots/contract.ts";
import { runtimeInput } from "./runtime-slots/input.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u));
const Time = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
export const RuntimeCrashCommand = Schema.Struct({
  controllerCode: ControllerCode,
  action: Schema.Literal("runtime-crash"),
  identity: SlotIdentity,
  nonce: Name,
  operator: Name,
  at: Time,
  expiresAt: Time,
  // Absent means the selected primary, so packets signed before cells existed keep their meaning.
  kind: Schema.optional(Schema.Literal("cell")),
});
export type RuntimeCrashCommand = typeof RuntimeCrashCommand.Type;
/** A cell packet says so. Every other packet names the selected primary. */
export const targetsCell = (command: RuntimeCrashCommand) => command.kind === "cell";
export const RuntimeCrashInspectCommand = Schema.Struct({
  controllerCode: ControllerCode,
  action: Schema.Literal("runtime-crash-inspect"),
  identity: SlotIdentity,
  nonce: Name,
  at: Time,
  expiresAt: Time,
});

// The controller signs this only after checking spare serving capacity. It is not an operator action.
export const RuntimeCrashAuthorization = Schema.Struct({
  command: RuntimeCrashCommand,
  sibling: SlotIdentity,
  checkedAt: Time,
  expiresAt: Time,
});
export type RuntimeCrashAuthorization = typeof RuntimeCrashAuthorization.Type;
export const crashNonceKey = (nonce: string) => `runtime-crash:command:${nonce}`;
export const crashAuditKey = (nonce: string) => `runtime-crash:audit:${nonce}`;

export function currentCrashCommand(value: unknown, now = Date.now()) {
  const command = runtimeInput(() =>
    Schema.decodeUnknownSync(RuntimeCrashCommand, { onExcessProperty: "error" })(value),
  );
  if (
    command.at > now ||
    command.expiresAt <= now ||
    command.expiresAt <= command.at ||
    command.expiresAt > command.at + 30_000
  )
    throw new SlotRefused("identity");
  return command;
}
