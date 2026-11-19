import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildProcessFailure, childReport, notStarted, type ChildReport } from "./failure/child.ts";

const tee = fileURLToPath(new URL("./failure/process-tee.ts", import.meta.url));

/**
 * The same as `run()` for a command that ends at once and is run many times over, such as each
 * step of the carry replay. Nothing stands in between, so it costs one process instead of two,
 * and its output arrives when it ends instead of as it is printed.
 */
export function runBuffered(
  command: string,
  args: string[],
  cwd?: string,
  env = process.env,
): void {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const output = { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
  if (!result.error && result.status === 0) return;
  const ended = result.error
    ? Reflect.get(result.error, "code") === "ENOBUFS"
      ? { exitCode: null, signal: result.signal, stopped: "output-limit" as const }
      : notStarted(result.error)
    : { exitCode: result.status, signal: result.signal };
  throw new ChildProcessFailure(childReport(command, ended, output, env));
}

/** The command's output stays live; a failure also carries its last lines, credentials removed. */
export function run(command: string, args: string[], cwd?: string, env = process.env): void {
  // NODE_OPTIONS are meant for the command. Loaded into the process in between, a preload could
  // stop the command from ever starting, so they travel under another name and are put back.
  const { NODE_OPTIONS: nodeOptions, ...rest } = env;
  // The report comes back in a file: Bun's spawnSync hands back no fourth stream. Where no file
  // can be made the command still runs, and its failure names the command and its exit.
  let directory: string | undefined;
  try {
    directory = mkdtempSync(join(tmpdir(), "basalt-run-"));
  } catch {
    directory = undefined;
  }
  try {
    const result = spawnSync(process.execPath, [tee, command, ...args], {
      // Bun loads an `.env` and a preload from the directory it starts in. Started in the
      // command's directory, the process in between would pass both on to the command.
      cwd: dirname(tee),
      env: {
        ...rest,
        BASALT_RUN_CWD: cwd ?? process.cwd(),
        ...(nodeOptions === undefined ? {} : { BASALT_RUN_NODE_OPTIONS: nodeOptions }),
        ...(directory ? { BASALT_RUN_REPORT: join(directory, "report.json") } : {}),
      },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status === 0) return;
    let report: ChildReport = {
      command: basename(command),
      exitCode: result.status,
      signal: result.signal,
      tail: "",
    };
    try {
      if (directory) report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
    } catch {
      // The report is an addition: without it the failure still names the command and its exit.
    }
    throw new ChildProcessFailure(report);
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
