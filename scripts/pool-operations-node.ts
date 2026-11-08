import { fork, type Serializable } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import type { PoolOperationsPlatform } from "./pool-operations.ts";

const reply = Schema.Struct({
  kind: Schema.Literals(["ready", "result", "error", "closed"]),
  id: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.Number),
  headers: Schema.optional(Schema.Array(Schema.Tuple([Schema.String, Schema.String]))),
  body: Schema.optional(Schema.String),
  name: Schema.optional(Schema.Literals(["Error", "TypeError", "AbortError", "TimeoutError"])),
});

/** Wrangler's remote dispatcher requires Node fetch. The caller may still run Alchemy in Bun. */
export async function nodePoolOperations(
  accountId: string,
  worker: string,
  entry = new URL("./pool-operations-node-worker.mjs", import.meta.url),
): Promise<PoolOperationsPlatform> {
  const child = fork(fileURLToPath(entry), [], {
    execPath: "node",
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      closed = true;
      const error = new Error("Private operations Node bridge exited");
      readyReject?.(error);
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      resolve();
    }),
  );
  const send = (value: Serializable) => {
    if (!child.connected) throw new Error("Private operations Node bridge disconnected");
    child.send(value, (error) => {
      if (!error) return;
      readyReject?.(new Error("Private operations Node bridge send failed"));
      for (const call of pending.values())
        call.reject(new Error("Private operations Node bridge send failed"));
      pending.clear();
    });
  };
  child.on("error", () => readyReject?.(new Error("Private operations Node bridge failed")));
  child.on("message", (input) => {
    let message: typeof reply.Type;
    try {
      message = Schema.decodeUnknownSync(reply)(input);
    } catch {
      child.kill();
      return;
    }
    if (message.kind === "ready") {
      readyResolve?.();
      return;
    }
    if (message.kind === "closed") {
      child.disconnect();
      return;
    }
    const call = message.id === undefined ? undefined : pending.get(message.id);
    const error = Object.assign(new Error("Private operations request failed"), {
      name: message.name ?? "Error",
    });
    if (!call) {
      if (message.kind === "error") readyReject?.(error);
      return;
    }
    pending.delete(message.id!);
    if (
      message.kind === "error" ||
      message.status === undefined ||
      !message.headers ||
      message.body === undefined
    )
      call.reject(error);
    else
      call.resolve(
        new Response(message.body ? Buffer.from(message.body, "base64") : null, {
          status: message.status,
          headers: message.headers.map(([key, value]) => [key, value]),
        }),
      );
  });
  const dispose = async () => {
    if (closed) return;
    try {
      send({ kind: "close" });
    } catch {
      child.kill();
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  send({ kind: "open", accountId, worker });
  const startup = setTimeout(() => {
    readyReject?.(new Error("Private operations Node bridge startup timed out"));
    child.kill();
  }, 30_000);
  try {
    await ready;
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    clearTimeout(startup);
  }
  return {
    dispose,
    env: {
      POOL_OPERATIONS: {
        async fetch(request) {
          if (closed) throw new Error("Private operations Node bridge closed");
          if (request.signal.aborted) throw new DOMException("Operation aborted", "AbortError");
          const id = ++sequence;
          const body = request.body
            ? Buffer.from(await request.arrayBuffer()).toString("base64")
            : undefined;
          const abort = () => {
            pending.get(id)?.reject(new DOMException("Operation aborted", "AbortError"));
            pending.delete(id);
            try {
              send({ kind: "cancel", id });
            } catch {}
          };
          try {
            return await new Promise<Response>((resolve, reject) => {
              pending.set(id, { resolve, reject });
              request.signal.addEventListener("abort", abort, { once: true });
              send({
                kind: "request",
                id,
                url: request.url,
                method: request.method,
                headers: [...request.headers],
                body,
              });
            });
          } finally {
            pending.delete(id);
            request.signal.removeEventListener("abort", abort);
          }
        },
      },
    },
  };
}
