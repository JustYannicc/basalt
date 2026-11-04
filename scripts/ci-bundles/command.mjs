import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export function command(program, args, { cwd, env, timeoutMs, log, monitor, suite, echo = false }) {
  return new Promise((resolve) => {
    const output = createWriteStream(log, { flags: "a" });
    const child = spawn(program, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    let failure;
    let escalation;
    const stop = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch (error) {
        if (error.code !== "ESRCH") failure = error.message;
      }
      escalation ??= setTimeout(() => {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The owned group already exited. */ }
      }, 5_000);
      escalation.unref();
    };
    const deadline = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, timeoutMs));
    deadline.unref();
    const interrupt = () => stop();
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    if (child.pid) monitor?.register(suite, child.pid);
    if (echo) {
      child.stdout?.pipe(process.stdout, { end: false });
      child.stderr?.pipe(process.stderr, { end: false });
    }
    child.stdout?.pipe(output, { end: false });
    child.stderr?.pipe(output, { end: false });
    child.once("error", (error) => { failure = error.message; });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(escalation);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      monitor?.sample();
      monitor?.unregister(child.pid);
      output.end(() => resolve({ code: code ?? 1, signal, timedOut, ...(failure ? { failure } : {}) }));
    });
  });
}
