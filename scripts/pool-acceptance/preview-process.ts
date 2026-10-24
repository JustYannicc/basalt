import { spawn, type ChildProcess } from "node:child_process";

export type PreviewProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  failedToStart: boolean;
};

type ActiveProcess = {
  child: ChildProcess;
  done: Promise<PreviewProcessResult>;
};

export type PreviewProcessRunner = {
  run(file: string, args: string[], cwd: string, timeoutMs: number): Promise<PreviewProcessResult>;
  stop(): Promise<void>;
};

export function createPreviewProcessRunner(options: {
  env: NodeJS.ProcessEnv;
  outputLimit?: number;
  killGraceMs?: number;
}): PreviewProcessRunner {
  const outputLimit = options.outputLimit ?? 512 * 1024;
  const killGraceMs = options.killGraceMs ?? 1_500;
  let active: ActiveProcess | undefined;

  const signalOwned = (child: ChildProcess, signal: NodeJS.Signals): void => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* The owned process group may already have exited. */ }
  };

  const stop = async (): Promise<void> => {
    const current = active;
    if (!current) return;
    signalOwned(current.child, "SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([current.done, new Promise(resolve => { timer = setTimeout(resolve, killGraceMs); })]);
    if (timer) clearTimeout(timer);
    if (active === current) signalOwned(current.child, "SIGKILL");
    await current.done;
  };

  return {
    async run(file, args, cwd, timeoutMs) {
      if (active) throw new Error("Preview process runner is already active");
      const stdoutParts: Buffer[] = [], stderrParts: Buffer[] = [];
      let stdoutSize = 0, stderrSize = 0, truncated = false, timedOut = false, failedToStart = false;
      let timer: NodeJS.Timeout | undefined, killTimer: NodeJS.Timeout | undefined;
      let resolveDone!: (result: PreviewProcessResult) => void;
      const done = new Promise<PreviewProcessResult>(resolveDonePromise => { resolveDone = resolveDonePromise; });
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(file, args, {
          cwd,
          env: options.env,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        return { code: null, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, failedToStart: true };
      }
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        const result = {
          code, signal,
          stdout: Buffer.concat(stdoutParts).toString("utf8"),
          stderr: Buffer.concat(stderrParts).toString("utf8"),
          timedOut, truncated, failedToStart,
        };
        if (active?.child === child) active = undefined;
        resolveDone(result);
      };
      const capture = (parts: Buffer[], size: number, chunk: Buffer): { size: number; truncated: boolean } => {
        const length = Math.min(outputLimit - size, chunk.length);
        if (length > 0) parts.push(Buffer.from(chunk.subarray(0, length)));
        return { size: size + length, truncated: length < chunk.length };
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        const next = capture(stdoutParts, stdoutSize, chunk);
        stdoutSize = next.size; truncated ||= next.truncated;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const next = capture(stderrParts, stderrSize, chunk);
        stderrSize = next.size; truncated ||= next.truncated;
      });
      child.once("error", () => { failedToStart = true; finish(null, null); });
      child.once("close", (code, signal) => finish(code, signal));
      active = { child, done };
      timer = setTimeout(() => {
        timedOut = true;
        signalOwned(child, "SIGTERM");
        killTimer = setTimeout(() => signalOwned(child, "SIGKILL"), killGraceMs);
      }, timeoutMs);
      return done;
    },
    stop,
  };
}
