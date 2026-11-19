import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildProcessFailure, type ChildReport } from "./failure/child.ts";

const tee = fileURLToPath(new URL("./failure/process-tee.ts", import.meta.url));

/** The command's output stays live; a failure also carries its last lines, credentials removed. */
export function run(command: string, args: string[], cwd?: string, env = process.env): void {
  // NODE_OPTIONS are meant for the command. Loaded into the process in between, a preload could
  // stop the command from ever starting, so they travel under another name and are put back.
  const { NODE_OPTIONS: nodeOptions, ...rest } = env;
  // A file, not a descriptor: Bun's spawnSync hands back no fourth stream.
  const directory = mkdtempSync(join(tmpdir(), "basalt-run-"));
  const reportPath = join(directory, "report.json");
  try {
    const result = spawnSync(process.execPath, [tee, command, ...args], {
      cwd,
      env: {
        ...rest,
        ...(nodeOptions === undefined ? {} : { BASALT_RUN_NODE_OPTIONS: nodeOptions }),
        BASALT_RUN_REPORT: reportPath,
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
      report = JSON.parse(readFileSync(reportPath, "utf8"));
    } catch {
      // The report is an addition: without it the failure still names the command and its exit.
    }
    throw new ChildProcessFailure(report);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
