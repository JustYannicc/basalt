import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

interface Result {
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

export async function homeProcess(binary: string, databaseUrl: string) {
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      HOME_BUDGET_DATABASE_URL: databaseUrl,
      CLIPROXY_DIAGNOSTICS_METADATA_ONLY: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const ready = Promise.withResolvers<void>();
  const pending = new Map<
    string,
    { resolve: (value: Result) => void; reject: (error: Error) => void }
  >();
  let sequence = 0;
  let tail = "";
  child.stderr.on("data", (data: Buffer) => {
    tail = (tail + data.toString()).slice(-4_000);
  });
  child.on("error", (error) => {
    ready.reject(error);
    for (const request of pending.values()) request.reject(error);
  });
  child.on("exit", (code) => {
    if (code !== 0 || pending.size) {
      const error = new Error(`Home proof process exited ${code}: ${tail}`);
      ready.reject(error);
      for (const request of pending.values()) request.reject(error);
    }
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("HOME_BUDGET ")) return;
    const value: unknown = JSON.parse(line.slice("HOME_BUDGET ".length));
    if (typeof value !== "object" || value === null || !("event" in value)) return;
    if (value.event === "ready") ready.resolve();
    if (
      value.event === "complete" &&
      "id" in value &&
      typeof value.id === "string" &&
      "ok" in value &&
      typeof value.ok === "boolean" &&
      "elapsedMs" in value &&
      typeof value.elapsedMs === "number"
    ) {
      pending.get(value.id)?.resolve({
        ok: value.ok,
        elapsedMs: value.elapsedMs,
        ...("error" in value && typeof value.error === "string" ? { error: value.error } : {}),
      });
      pending.delete(value.id);
    }
  });
  const startup = setTimeout(() => ready.reject(new Error("Home proof startup timed out")), 10_000);
  try {
    await ready.promise;
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  } finally {
    clearTimeout(startup);
  }
  return {
    request(operation: "migrate" | "initialize" | "update") {
      const id = String(++sequence);
      const response = Promise.withResolvers<Result>();
      pending.set(id, response);
      child.stdin.write(JSON.stringify({ id, operation }) + "\n");
      return response.promise;
    },
    async close() {
      child.stdin.end();
      const deadline = setTimeout(() => child.kill(), 3_000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
