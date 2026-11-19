/**
 * `run()` in `scripts/process.ts` is synchronous and shows a command's output as it arrives. This
 * stands between the two so the failure can also carry the end of that output: it passes everything
 * through and leaves the caller a report in the file the caller named.
 */
import { writeFileSync } from "node:fs";
import { captureChild, ChildProcessFailure } from "./child.ts";

// The caller's NODE_OPTIONS and directory are the command's, not this process's, and the report
// is not the command's business: see `run()`.
const {
  BASALT_RUN_NODE_OPTIONS: nodeOptions,
  BASALT_RUN_REPORT: reportPath,
  BASALT_RUN_CWD: cwd,
  ...environment
} = process.env;
if (nodeOptions !== undefined) environment.NODE_OPTIONS = nodeOptions;

const [command, ...args] = process.argv.slice(2);
try {
  await captureChild(command ?? "", args, { cwd, env: environment, forward: true });
} catch (error) {
  if (!(error instanceof ChildProcessFailure)) throw error;
  try {
    if (reportPath) writeFileSync(reportPath, JSON.stringify(error.report));
  } catch {
    // Without the report the caller still has the exit code.
  }
  process.exitCode = error.report.exitCode || 1;
}
