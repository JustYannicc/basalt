import { spawn } from "node:child_process";
import { appendFile, open, type FileHandle } from "node:fs/promises";
import { credentialName, publicGuidance } from "../failure/redact.ts";

/** Where a step writes its cleaned failure report for the caller to publish. */
export const failureReportVariable = "PREVIEW_FAILURE_REPORT";

type Operation = {
  label: string;
  command: string;
  args: string[];
  directory: string;
  environment: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** Where a failed step's report is published: the job's log and its step summary. */
type Publish = { environment: NodeJS.ProcessEnv; write(text: string): void };

/**
 * The runner's environment with each string inside a JSON credential added: a subscription file's
 * `access_token` can be printed alone, and the step never held the credentials moved into files.
 */
export function publicEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const found: NodeJS.ProcessEnv = { ...environment };
  const leaves = (value: unknown, name: string): void => {
    if (typeof value === "string") found[`${name}_${Object.keys(found).length}`] = value;
    else if (value && typeof value === "object")
      for (const child of Object.values(value)) leaves(child, name);
  };
  for (const [name, value] of Object.entries(environment)) {
    if (!credentialName.test(name) || !value) continue;
    try {
      leaves(JSON.parse(value), name);
    } catch {
      // Not JSON: its whole value is already removed by name.
    }
  }
  return found;
}

const reportBytes = 64 * 1024;

/**
 * Only the report the step cleaned itself goes out, never its output. It is read through the file
 * this process made, bounded, and each line goes through the rules for a line written here with
 * every credential this process holds.
 */
async function publishReport(report: FileHandle, publish: Publish): Promise<void> {
  const { size } = await report.stat();
  const buffer = Buffer.alloc(Math.min(size, reportBytes));
  const { bytesRead } = await report.read(buffer, 0, buffer.length, 0);
  let raw = buffer.subarray(0, bytesRead).toString("utf8");
  if (size > reportBytes) {
    raw = `${raw.slice(0, raw.lastIndexOf("\n") + 1)}[cut]\n`;
    // A cut inside the summary's code block would leave the rest of the summary in it.
    if ((raw.match(/^```/gmu) ?? []).length % 2 === 1) raw += "```\n";
  }
  if (!raw.trim()) return;
  const environment = publicEnvironment(publish.environment);
  const text = raw
    .split("\n")
    .map((line) => publicGuidance(line, environment))
    .join("\n");
  publish.write(text);
  const summary = publish.environment.GITHUB_STEP_SUMMARY;
  if (summary)
    await appendFile(summary, text).catch(() =>
      publish.write("The step summary could not be written."),
    );
}

/**
 * Capture provider output privately. Errors exposed to Actions have fixed, credential-free labels;
 * a step that fails with a report of its own (`failureReportVariable`) has that report published.
 */
export async function privateOperation(
  operation: Operation,
  publish: Publish = { environment: process.env, write: (text) => console.error(text) },
): Promise<void> {
  if (!/^[a-z-]+$/.test(operation.label)) throw new Error("Invalid preview operation label");
  const log = await open(operation.logPath, "wx", 0o600);
  const reportPath = `${operation.logPath}.report`;
  // Made here, before the step runs, so what is read back is this file whatever the step does.
  const report = await open(reportPath, "wx+", 0o600).catch(async (error: unknown) => {
    await log.close();
    throw error;
  });
  try {
    if (operation.signal?.aborted) throw new Error(`Preview ${operation.label} cancelled`);
    const child = spawn(operation.command, operation.args, {
      cwd: operation.directory,
      env: { ...operation.environment, [failureReportVariable]: reportPath },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false,
      cancelled = false,
      oversized = false;
    let bytes = 0;
    const terminate = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const forceKill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      terminate();
      killTimer ??= setTimeout(forceKill, 2_000);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, operation.timeoutMs);
    operation.signal?.addEventListener("abort", abort, { once: true });
    const writes: Promise<unknown>[] = [];
    for (const stream of [child.stdout!, child.stderr!])
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          oversized = true;
          stop();
        } else writes.push(log.write(chunk));
      });
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", () => reject(new Error(`Preview ${operation.label} could not start`)));
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      operation.signal?.removeEventListener("abort", abort);
      await Promise.all(writes);
    }
    if (cancelled || timedOut || oversized || code !== 0) await publishReport(report, publish);
    if (cancelled) throw new Error(`Preview ${operation.label} cancelled`);
    if (timedOut) throw new Error(`Preview ${operation.label} timed out`);
    if (oversized) throw new Error(`Preview ${operation.label} exceeded its output limit`);
    if (code !== 0) throw new Error(`Preview ${operation.label} failed`);
  } finally {
    await log.close();
    await report.close();
  }
}
