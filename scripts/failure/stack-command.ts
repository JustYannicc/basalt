import { field, typeName } from "./cause.ts";
import { OutputTail, publicTail } from "./redact.ts";

/**
 * A command Alchemy ran for a resource (`Command.Exec`, `Command.Build`), read from the error
 * Alchemy raises when it fails. Alchemy 2.0.0-beta.80 collects the command's standard output and
 * standard error and puts only the exit code and the standard error in that error, so a command
 * that explains itself on standard output fails with nothing to read. The report says so instead
 * of printing an empty reason.
 *
 * Read by shape, like every failure here. The tests build Alchemy's own classes and run its own
 * runner, so a change in that shape fails them.
 */
export interface StackCommand {
  /** `node verify-database-budget.ts failed with exit 1`, already public. */
  what: string;
  /** What Alchemy's error keeps of the command's output, and what it does not. */
  why: string;
  /** The end of the command's standard error, already public. Empty when none is kept. */
  tail: string;
}

const nameLimit = 200;
// What Effect prints for a duration: `3m 5s`.
const duration = /^\d{1,9}(?:ms|[dhms])(?: \d{1,9}(?:ms|[dhms])){0,4}$/u;

export function stackCommand(
  error: unknown,
  environment: NodeJS.ProcessEnv,
): StackCommand | undefined {
  const command = field(error, "command");
  const reason = field(error, "reason");
  const tag = field(reason, "_tag");
  if (
    field(error, "_tag") !== "CommandError" ||
    typeof command !== "string" ||
    typeof tag !== "string"
  )
    return undefined;

  // The command line is whatever the stack passed: cleaned like output, whole values first, then
  // made one bounded line.
  const line = publicTail(command, environment).replace(/\s+/gu, " ").trim();
  const name = line.length > nameLimit ? `${line.slice(0, nameLimit)}[cut]` : line;
  const exitCode = field(reason, "exitCode");
  const timeout = field(reason, "timeout");
  const type = typeName(reason);
  let how = `did not succeed${type === "unknown" ? "" : ` (${type})`}`;
  if (tag === "UnexpectedExit")
    how = Number.isSafeInteger(exitCode) ? `failed with exit ${exitCode}` : "failed";
  if (tag === "CommandTimedOut")
    how = `timed out${typeof timeout === "string" && duration.test(timeout) ? ` after ${timeout}` : ""}`;

  // Alchemy does not bound what it collected, so the window a command run here gets applies. The
  // slice only spares copying more than that window can use.
  const stderr = tag === "UnexpectedExit" ? field(reason, "stderr") : undefined;
  const kept = new OutputTail();
  if (typeof stderr === "string") kept.push(Buffer.from(stderr.slice(-(1 << 20))));
  const lines = publicTail(kept.text(), environment);
  const printed = lines.trim() !== "";
  let why = "Its error for this keeps none of the command's output.";
  if (printed)
    why =
      "Its error keeps the command's standard error, whose last lines are below, and none of its standard output.";
  else if (typeof stderr === "string")
    why =
      "It printed nothing on standard error, and Alchemy's error keeps no standard output, so what the command said about its failure is not in this report.";
  return {
    what: `${name || "A command"} ${how}`,
    why: `Alchemy ran this command for a resource. ${why}`,
    tail: printed ? `--- stderr\n${lines}` : "",
  };
}
