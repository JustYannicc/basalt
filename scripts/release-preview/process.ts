import { spawn } from "node:child_process";
import { appendFile, open, readFile } from "node:fs/promises";
import { credentialName, redactCredentials } from "../failure/redact.ts";

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
 * A credential's own value, and each string inside one that is JSON: a subscription file's
 * `access_token` can be printed alone. The step never held the ones moved into files. The zone
 * previews run under goes too: a tail keeps a hostname written bare, and every preview host is in it.
 */
function credentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const found: NodeJS.ProcessEnv = {
    ...environment,
    PREVIEW_ZONE_SECRET: environment.TEST_STAGE_DOMAIN,
  };
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

/**
 * Only the report the step cleaned itself goes out, never its output, and it is cleaned again with
 * every credential this process holds.
 */
async function publishReport(path: string, publish: Publish): Promise<void> {
  const report = await readFile(path, "utf8").catch(() => "");
  if (!report.trim()) return;
  const text = redactCredentials(report.slice(0, 64 * 1024), credentials(publish.environment));
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
    if (cancelled || timedOut || oversized || code !== 0) await publishReport(reportPath, publish);
    if (cancelled) throw new Error(`Preview ${operation.label} cancelled`);
    if (timedOut) throw new Error(`Preview ${operation.label} timed out`);
    if (oversized) throw new Error(`Preview ${operation.label} exceeded its output limit`);
    if (code !== 0) throw new Error(`Preview ${operation.label} failed`);
  } finally {
    await log.close();
  }
}
