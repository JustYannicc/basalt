import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChildProcessFailure, type ChildReport } from "./failure/child.ts";

const tee = fileURLToPath(new URL("./failure/process-tee.ts", import.meta.url));

/** The command's output stays live; a failure also carries its last lines, credentials removed. */
export function run(command: string, args: string[], cwd?: string, env = process.env): void {
  const result = spawnSync(process.execPath, [tee, command, ...args], {
    cwd,
    env,
    stdio: ["inherit", "inherit", "inherit", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  let report: ChildReport = { command, exitCode: result.status, signal: result.signal, tail: "" };
  try {
    report = JSON.parse(String(result.output[3]));
  } catch {
    // The report is an addition: without it the failure still names the command and its exit.
  }
  throw new ChildProcessFailure(report);
}
