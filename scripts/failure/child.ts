import { spawn } from "node:child_process";
import { basename } from "node:path";
import { OutputTail, publicTail, redactCredentials } from "./redact.ts";

export interface ChildReport {
  command: string;
  exitCode: number | null;
  signal: string | null;
  /** Why the command never ran or was stopped, when it did not simply exit. */
  stopped?: "not-started" | "output-limit";
  /** The last output lines, already public. */
  tail: string;
}

/** A command that did not succeed, with the end of what it printed. */
export class ChildProcessFailure extends Error {
  readonly report: ChildReport;

  constructor(report: ChildReport) {
    const how =
      report.stopped === "not-started"
        ? "could not start"
        : report.stopped === "output-limit"
          ? "printed more than its output limit and was stopped"
          : `failed with ${report.signal ?? `exit ${report.exitCode}`}`;
    super(
      `${report.command} ${how}${report.tail ? `\nLast output lines, credentials removed:\n${report.tail}` : ""}`,
    );
    this.name = "ChildProcessFailure";
    this.report = report;
  }
}

/**
 * Runs a command and keeps the end of its output for the failure. `forward` also passes the output
 * on as it arrives. Settles on exit: a descendant that inherited the pipes cannot hold the caller.
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
  // Only the program's name: its directory and arguments can carry values no log should repeat.
  const name = redactCredentials(basename(command), environment).slice(0, 128);
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
        if (options.maximumOutputBytes !== undefined && bytes > options.maximumOutputBytes) {
          if (!overLimit) child.kill("SIGTERM");
          overLimit = true;
        }
      });
    const signals = ["SIGINT", "SIGTERM"] as const;
    const pass = Object.fromEntries(signals.map((signal) => [signal, () => child.kill(signal)]));
    for (const signal of signals) process.once(signal, pass[signal]!);
    let settled = false;
    const settle = (failure?: Omit<ChildReport, "command" | "tail">) => {
      if (settled) return;
      settled = true;
      for (const signal of signals) process.removeListener(signal, pass[signal]!);
      child.stdout.destroy();
      child.stderr.destroy();
      if (!failure) return resolve();
      const output = (["stdout", "stderr"] as const)
        .map((stream) => [stream, tails[stream].text()] as const)
        .filter(([, text]) => text.trim())
        .map(([stream, text]) => `--- ${stream}\n${publicTail(text, environment)}`)
        .join("\n");
      reject(new ChildProcessFailure({ command: name, ...failure, tail: output }));
    };
    child.once("error", () => settle({ exitCode: null, signal: null, stopped: "not-started" }));
    child.once("exit", (exitCode, signal) => {
      const finish = () =>
        settle(
          overLimit
            ? { exitCode, signal, stopped: "output-limit" }
            : exitCode === 0
              ? undefined
              : { exitCode, signal },
        );
      // What the command already wrote is in the pipes; a short grace reads it.
      const grace = setTimeout(finish, 250);
      child.once("close", () => {
        clearTimeout(grace);
        finish();
      });
    });
  });
}
