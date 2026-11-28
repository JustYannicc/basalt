import { Schema } from "effect";
import { ControllerCode, SlotIdentity, SlotRefused } from "./runtime-slots/contract.ts";
import { runtimeInput } from "./runtime-slots/input.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u));
const Time = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
/** A pool as the controller names the calls it admits under it. */
export const CrashPool = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/u));
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
  // A cell packet only: the test's own pool, the one pool whose calls the kill may cut.
  onlyPool: Schema.optional(CrashPool),
});
export type RuntimeCrashCommand = typeof RuntimeCrashCommand.Type;
/** A cell packet says so. Every other packet names the selected primary. */
export const targetsCell = (command: RuntimeCrashCommand) => command.kind === "cell";

/**
 * A cell kill refused because a call from a pool other than the packet's, or one whose pool the
 * controller can't name, is in flight on the cell. Nothing was signalled.
 */
export class CrashPoolRefused extends SlotRefused {
  readonly otherPools: number;
  readonly unnamed: number;
  constructor(otherPools: number, unnamed: number) {
    super("selection");
    this.otherPools = otherPools;
    this.unnamed = unnamed;
  }
}
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
    command.expiresAt > command.at + 30_000 ||
    // A cell packet without its pool is refused, never read as allowing any pool.
    targetsCell(command) !== (command.onlyPool !== undefined)
  )
    throw new SlotRefused("identity");
  return command;
}
