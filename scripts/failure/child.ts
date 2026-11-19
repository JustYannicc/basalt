import { spawn } from "node:child_process";
import { basename } from "node:path";
import { OutputTail, publicTail, redactCredentials } from "./redact.ts";

export interface ChildReport {
  command: string;
  exitCode: number | null;
  signal: string | null;
  /** Why the command never ran or was stopped, when it did not simply exit. */
  stopped?: "not-started" | "output-limit";
  /** The system's reason a command could not start, such as `ENOENT`. */
  code?: string;
  /** The last output lines, already public. */
  tail: string;
}

/** A command that did not succeed, with the end of what it printed. */
export class ChildProcessFailure extends Error {
  declare readonly report: ChildReport;

  constructor(report: ChildReport) {
    const how =
      report.stopped === "not-started"
        ? `could not start${report.code ? ` (${report.code})` : ""}`
        : report.stopped === "output-limit"
          ? "printed more than its output limit and was stopped"
          : `failed with ${report.signal ?? `exit ${report.exitCode}`}`;
    super(
      `${report.command} ${how}${report.tail ? `\nLast output lines, credentials removed:\n${report.tail}` : ""}`,
    );
    this.name = "ChildProcessFailure";
    // Not enumerable: an uncaught failure would print the output again under its message.
    Object.defineProperty(this, "report", { value: report });
  }
}

type Ended = Omit<ChildReport, "command" | "tail">;
/** How long a stopped or ended command is given to let go, in milliseconds. */
const handover = 2000;

/** A command that could not be started, with the system's reason when it is one. */
export function notStarted(error: Error): Ended {
  const code = String(Reflect.get(error, "code"));
  return {
    exitCode: null,
    signal: null,
    stopped: "not-started",
    ...(/^E[A-Z]{2,14}$/u.test(code) ? { code } : {}),
  };
}

/**
 * What is kept of a command that did not succeed. Of its command line only the program's name:
 * its directory and arguments can carry values no log should repeat. Of its output the end of
 * each stream it printed on.
 */
export function childReport(
  command: string,
  ended: Ended,
  output: Record<"stdout" | "stderr", string>,
  environment: NodeJS.ProcessEnv,
): ChildReport {
  return {
    command: redactCredentials(basename(command), environment).slice(0, 128),
    ...ended,
    tail: (["stdout", "stderr"] as const)
      .filter((stream) => output[stream].trim())
      .map((stream) => `--- ${stream}\n${publicTail(output[stream], environment)}`)
      .join("\n"),
  };
}

/**
 * Runs a command and keeps the end of its output for the failure. Settles on exit: a descendant
 * that inherited the pipes cannot hold the caller.
 *
 * `forward` stands in for inherited output: everything is passed on as it arrives, the command
 * reads the caller's input, and an interrupt is left to reach the command the way it reaches this
 * process, once. Without it the command is this process's alone, so an interrupt is passed on.
 */
export function captureChild(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    forward?: boolean;
    /** Stop a command that prints more than this many bytes. */
    maximumOutputBytes?: number;
  } = {},
): Promise<void> {
  const environment = options.env ?? process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: environment,
      stdio: [options.forward ? "inherit" : "ignore", "pipe", "pipe"],
    });
    const tails = { stdout: new OutputTail(), stderr: new OutputTail() };
    let bytes = 0;
    let overLimit = false;
    for (const stream of ["stdout", "stderr"] as const)
      child[stream].on("data", (chunk: Buffer) => {
        tails[stream].push(chunk);
        if (options.forward) process[stream].write(chunk);
        bytes += chunk.length;
        if (
          options.maximumOutputBytes !== undefined &&
          bytes > options.maximumOutputBytes &&
          !overLimit
        ) {
          overLimit = true;
          child.kill("SIGTERM");
          // A command that ignores the request to stop is not waited for.
          setTimeout(() => child.kill("SIGKILL"), handover).unref();
        }
      });
    const signals = ["SIGINT", "SIGTERM"] as const;
    const pass = Object.fromEntries(
      signals.map((signal) => [signal, () => void (options.forward || child.kill(signal))]),
    );
    for (const signal of signals) process.once(signal, pass[signal]!);
    let settled = false;
    const settle = (failure?: Ended) => {
      if (settled) return;
      settled = true;
      for (const signal of signals) process.removeListener(signal, pass[signal]!);
      child.stdout.destroy();
      child.stderr.destroy();
      if (!failure) return resolve();
      const output = { stdout: tails.stdout.text(), stderr: tails.stderr.text() };
      reject(new ChildProcessFailure(childReport(command, failure, output, environment)));
    };
    child.once("error", (error) => settle(notStarted(error)));
    child.once("exit", (exitCode, signal) => {
      const finish = () =>
        settle(
          overLimit
            ? { exitCode, signal, stopped: "output-limit" }
            : exitCode === 0
              ? undefined
              : { exitCode, signal },
        );
      // What the command already wrote is in the pipes. A loaded machine needs longer to hand it
      // over than a quiet one, and only a descendant that keeps the pipes open waits this out.
      const grace = setTimeout(finish, handover);
      child.once("close", () => {
        clearTimeout(grace);
        finish();
      });
    });
  });
}
