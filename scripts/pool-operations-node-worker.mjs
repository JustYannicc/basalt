import { openPoolOperations } from "./pool-operations.ts";

let connection;
const calls = new Map();
const send = (value) => {
  if (process.connected) process.send(value);
};
const close = async () => {
  for (const controller of calls.values()) controller.abort();
  await connection?.close();
};
process.once("disconnect", () => {
  void close().finally(() => process.exit());
});
process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  try {
    if (
      message.kind === "open" &&
      !connection &&
      typeof message.accountId === "string" &&
      typeof message.worker === "string"
    ) {
      connection = await openPoolOperations({
        accountId: message.accountId,
        worker: message.worker,
      });
      send({ kind: "ready" });
    } else if (message.kind === "close") {
      await close();
      send({ kind: "closed" });
    } else if (message.kind === "cancel") calls.get(message.id)?.abort();
    else if (
      message.kind === "request" &&
      connection &&
      Number.isSafeInteger(message.id) &&
      typeof message.url === "string" &&
      typeof message.method === "string" &&
      Array.isArray(message.headers)
    ) {
      const url = new URL(message.url);
      if (url.origin !== "http://pool-operations" || !["GET", "POST"].includes(message.method))
        throw new Error();
      const controller = new AbortController();
      calls.set(message.id, controller);
      try {
        const response = await connection.service.fetch(
          new Request(url, {
            method: message.method,
            headers: message.headers,
            body: message.body ? Buffer.from(message.body, "base64") : undefined,
            signal: controller.signal,
          }),
        );
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > 1_048_576) throw new Error();
        send({
          kind: "result",
          id: message.id,
          status: response.status,
          headers: [...response.headers],
          body: body.toString("base64"),
        });
      } finally {
        calls.delete(message.id);
      }
    }
  } catch (error) {
    const name = ["TypeError", "AbortError", "TimeoutError"].includes(error?.name)
      ? error.name
      : "Error";
    send({ kind: "error", ...(Number.isSafeInteger(message.id) ? { id: message.id } : {}), name });
  }
});
