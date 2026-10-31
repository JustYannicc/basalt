import { request } from "node:http";
import { readConnectionView } from "../contracts/connection.ts";

/** The SDK still sees HTTP; only its local hop uses the profile's private socket. */
export function ipcFetch(socketPath: string, token: string) {
  return (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.origin !== "http://localhost")
      return Promise.reject(new Error("IPC destination refused."));
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("host", "localhost");
    const body = init?.body;
    if (
      body !== undefined &&
      body !== null &&
      typeof body !== "string" &&
      !(body instanceof Uint8Array)
    )
      return Promise.reject(new Error("IPC request body refused."));
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: Object.fromEntries(headers),
          ...(init?.signal ? { signal: init.signal } : {}),
        },
        (incoming) => {
          const resultHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (value !== undefined)
              resultHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
          const status = incoming.statusCode ?? 502;
          const iterator = incoming[Symbol.asyncIterator]();
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) controller.close();
                else if (Buffer.isBuffer(next.value))
                  controller.enqueue(new Uint8Array(next.value));
                else controller.error(new Error("Unexpected IPC response chunk."));
              } catch {
                controller.error(new Error("The IPC response was interrupted."));
              }
            },
            cancel() {
              incoming.destroy();
            },
          });
          resolve(
            new Response([204, 205, 304].includes(status) ? null : stream, {
              status,
              headers: resultHeaders,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };
}

export async function control(socketPath: string, token: string, command: string) {
  if (!["status", "health", "disconnect", "reconnect", "sign-out", "revoke"].includes(command))
    throw new Error("Unknown connection command.");
  const response = await ipcFetch(socketPath, token)(`http://localhost/client/${command}`, {
    method: command === "status" || command === "health" ? "GET" : "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("The connection command was refused.");
  return readConnectionView(await response.json());
}
