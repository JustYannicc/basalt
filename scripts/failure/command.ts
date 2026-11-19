import { field } from "./cause.ts";
import { ChildProcessFailure } from "./child.ts";
import { OutputTail, publicGuidance, publicLine, publicTail, publicText } from "./redact.ts";

/**
 * A command that did not succeed, as the report tells it: its name and how it ended, why, the fix
 * that fits, and what is kept of its output.
 *
 * It is either a command run here, which carries the end of its output, or one Alchemy ran for a
 * resource (`Command.Exec`, `Command.Build`), read from the error Alchemy raises. Alchemy
 * 2.0.0-beta.80 collects such a command's standard output and standard error and puts only the
 * exit code and the standard error in that error, so a command that explains itself on standard
 * output fails with nothing to read. The report says so instead of printing an empty reason.
 *
 * Alchemy's error is read by shape, like every failure here. The tests build its own classes and
 * run its own runner, so a change in that shape fails them.
 */
export interface FailedCommand {
  code: "CHILD_FAILED" | "STACK_COMMAND_FAILED";
  /** `node verify-database-budget.ts failed with exit 1`, already public. */
  what: string;
  why: string;
  fix: string;
  /** The end of what is kept of its output, already public. Empty when nothing is. */
  tail: string;
}

const alone =
  "Run the command alone to see what it prints, fix what that names, then rerun this step.";
const installed =
  "Check that the program is installed and on the path and that its working directory exists";

function ranHere(failure: ChildProcessFailure, environment: NodeJS.ProcessEnv): FailedCommand {
  // Made public again here: a report built by a caller is not known to be.
  const tail = publicTail(failure.report.tail, environment);
  const told = (why: string, fix: string): FailedCommand => ({
    code: "CHILD_FAILED",
    what: publicGuidance(failure.message.split("\n")[0]!, environment),
    why,
    fix,
    tail,
  });
  if (failure.report.stopped === "not-started")
    return told(
      "The command never ran, so it changed nothing.",
      `${installed}, then rerun this step.`,
    );
  if (failure.report.stopped === "output-limit")
    return told(
      "The command printed more than this step keeps and was stopped part-way.",
      "Find why it prints so much, starting at its last lines below. It was stopped part-way, so check what it had already changed before rerunning this step.",
    );
  return tail.trim()
    ? told(
        "A command this step ran did not succeed. Its last output lines are below.",
        "Fix what the output names and rerun this step.",
      )
    : told("A command this step ran did not succeed and printed nothing.", alone);
}

// What Effect prints for a duration: `3m 5s`.
const duration = /^\d{1,9}(?:ms|[dhms])(?: \d{1,9}(?:ms|[dhms])){0,4}$/u;
// Effect's names for what the system said when a process could not be started or was lost.
const systemTags = new Set([
  "AlreadyExists",
  "BadResource",
  "Busy",
  "InvalidData",
  "NotFound",
  "PermissionDenied",
  "TimedOut",
  "UnexpectedEof",
  "Unknown",
  "WouldBlock",
  "WriteZero",
]);

function ranByAlchemy(error: unknown, environment: NodeJS.ProcessEnv): FailedCommand | undefined {
  const command = field(error, "command");
  const reason = field(error, "reason");
  const tag = field(reason, "_tag");
  if (
    field(error, "_tag") !== "CommandError" ||
    typeof command !== "string" ||
    typeof tag !== "string"
  )
    return undefined;
  // The command line is whatever the stack passed, so it is cleaned like output.
  const name = publicLine(command, environment) || "A command";
  const ended = (how: string, why: string, fix: string, tail = ""): FailedCommand => ({
    code: "STACK_COMMAND_FAILED",
    what: `${name} ${how}`,
    why,
    fix,
    tail,
  });
  const ran = "Alchemy ran this command for a resource";

  if (tag === "UnexpectedExit") {
    const exitCode = field(reason, "exitCode");
    const how = Number.isSafeInteger(exitCode) ? `failed with exit ${exitCode}` : "failed";
    const stderr = field(reason, "stderr");
    if (typeof stderr !== "string")
      return ended(how, `${ran}. Its error keeps none of the command's output.`, alone);
    // Alchemy does not bound what it collected, so the window a command run here gets applies.
    // The slice only spares copying more than that window can use.
    const kept = new OutputTail();
    kept.push(Buffer.from(stderr.slice(-(1 << 20))));
    const lines = publicTail(kept.text(), environment);
    return lines.trim()
      ? ended(
          how,
          `${ran}. Its error keeps the command's standard error, whose last lines are below, and none of its standard output.`,
          "Fix what those lines name and rerun this step. If they do not explain the failure, run the command alone to see what it prints on standard output.",
          `--- stderr\n${lines}`,
        )
      : ended(
          how,
          `${ran}. It printed nothing on standard error, and Alchemy's error keeps no standard output, so what the command said about its failure is not in this report.`,
          alone,
        );
  }
  if (tag === "CommandTimedOut") {
    const timeout = field(reason, "timeout");
    return ended(
      `timed out${typeof timeout === "string" && duration.test(timeout) ? ` after ${timeout}` : ""}`,
      `${ran} and stopped it at its time limit. Its error keeps none of the command's output.`,
      "The command was stopped part-way, so check what it had already changed. Run it alone to see where its time goes, then rerun this step.",
    );
  }
  if (tag === "OutputNotFound")
    return ended(
      "ended without its declared output",
      `${ran}, and the path the resource declares as its output does not exist afterwards.`,
      "Make the command write that path, or correct the resource's declared output, then rerun this step.",
    );
  if (tag === "BadArgument") {
    const description = field(reason, "description");
    return ended(
      "was refused as it was given",
      typeof description === "string" && description.trim()
        ? `It was refused before it ran: ${publicText(description, environment).replace(/[.!?]$/u, "")}.`
        : "It was refused before it ran.",
      "Fix the resource's command, working directory or time limit, then rerun this step.",
    );
  }
  if (systemTags.has(tag))
    return ended(
      `could not be run to its end (${tag})`,
      "Alchemy could not start this command, or lost it while it ran. Its error keeps none of the command's output.",
      `${installed}. If it had started, check what it changed before rerunning this step.`,
    );
  return ended("did not succeed", `${ran}. Its error keeps none of the command's output.`, alone);
}

export const failedCommand = (
  value: unknown,
  environment: NodeJS.ProcessEnv,
): FailedCommand | undefined =>
  value instanceof ChildProcessFailure
    ? ranHere(value, environment)
    : ranByAlchemy(value, environment);
