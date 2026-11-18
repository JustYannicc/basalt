/**
 * `run()` in `scripts/process.ts` is synchronous and shows a command's output as it arrives. This
 * stands between the two so the failure can also carry the end of that output: it passes everything
 * through and hands the caller a report on descriptor 3.
 */
import { writeSync } from "node:fs";
import { captureChild, ChildProcessFailure } from "./child.ts";

// The caller's NODE_OPTIONS are the command's, not this process's: see `run()`.
const { BASALT_RUN_NODE_OPTIONS: nodeOptions, ...environment } = process.env;
if (nodeOptions !== undefined) environment.NODE_OPTIONS = nodeOptions;

const [command, ...args] = process.argv.slice(2);
try {
  await captureChild(command ?? "", args, { env: environment, forward: true });
} catch (error) {
  if (!(error instanceof ChildProcessFailure)) throw error;
  try {
    writeSync(3, JSON.stringify(error.report));
  } catch {
    // Without the descriptor the caller still has the exit code.
  }
  process.exitCode = error.report.exitCode || 1;
}
