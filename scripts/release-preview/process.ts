import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

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

/** Capture provider output privately. Errors exposed to Actions have fixed, credential-free labels. */
export async function privateOperation(operation: Operation): Promise<void> {
  if (!/^[a-z-]+$/.test(operation.label)) throw new Error("Invalid preview operation label");
  const log = await open(operation.logPath, "wx", 0o600);
  try {
    if (operation.signal?.aborted) throw new Error(`Preview ${operation.label} cancelled`);
    const child = spawn(operation.command, operation.args, {
      cwd: operation.directory, env: operation.environment,
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false, cancelled = false, oversized = false;
    let bytes = 0;
    const terminate = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const forceKill = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { terminate(); killTimer ??= setTimeout(forceKill, 2_000); };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, operation.timeoutMs);
    operation.signal?.addEventListener("abort", abort, { once: true });
    const writes: Promise<unknown>[] = [];
    for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { oversized = true; stop(); }
      else writes.push(log.write(chunk));
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
    if (cancelled) throw new Error(`Preview ${operation.label} cancelled`);
    if (timedOut) throw new Error(`Preview ${operation.label} timed out`);
    if (oversized) throw new Error(`Preview ${operation.label} exceeded its output limit`);
    if (code !== 0) throw new Error(`Preview ${operation.label} failed`);
  } finally { await log.close(); }
}
