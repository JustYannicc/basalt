import { spawn } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { redactor } from "./redact.ts";

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

/**
 * Capture provider output in a private log. A failure prints that log's tail with every secret
 * value redacted: a swallowed error once cost a whole release cycle.
 */
/** The redacted tail of a failed child's own output, so the job log always shows the real error. */
async function printFailure(operation: Operation): Promise<void> {
  const text = await readFile(operation.logPath, "utf8").catch(() => "");
  const redact = redactor(operation.environment, process.env);
  const tail = text.split(/\r?\n/u).filter(Boolean).slice(-60).join("\n");
  console.error(
    `::group::${operation.label} output (last 60 lines, secrets redacted)\n${redact(tail)}\n::endgroup::`,
  );
}

export async function privateOperation(operation: Operation): Promise<void> {
  if (!/^[a-z-]+$/.test(operation.label)) throw new Error("Invalid preview operation label");
  const log = await open(operation.logPath, "wx", 0o600);
  try {
    if (operation.signal?.aborted) throw new Error(`Preview ${operation.label} cancelled`);
    const child = spawn(operation.command, operation.args, {
      cwd: operation.directory,
      env: operation.environment,
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
    const failure = cancelled
      ? "cancelled"
      : timedOut
        ? "timed out"
        : oversized
          ? "exceeded its output limit"
          : code !== 0
            ? "failed"
            : undefined;
    if (failure) {
      await log.close();
      await printFailure(operation);
      throw new Error(`Preview ${operation.label} ${failure}`);
    }
  } finally {
    await log.close().catch(() => {});
  }
}
