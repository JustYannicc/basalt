import { WebSocketServer } from "ws";
import type { Server } from "node:http";

/** Synthetic Responses peer for installed Codex, which selects WebSocket when advertised. */
export function installedModelPeer(
  server: Server,
  key: string,
  jwt: string,
  respond: (request: Request) => Promise<Response>,
  fail: (message: string) => void,
) {
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/v1/responses" ||
      request.headers["x-api-key"] !== key ||
      request.headers.authorization !== `Bearer ${jwt}`
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (peer) => {
      peer.on("message", (bytes) => {
        void (async () => {
          const body: unknown = JSON.parse(bytes.toString());
          if (
            !body ||
            typeof body !== "object" ||
            !("type" in body) ||
            body.type !== "response.create"
          )
            throw new Error("Expected response.create");
          const response = await respond(
            new Request("http://127.0.0.1/v1/responses", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-api-key": key,
                authorization: `Bearer ${jwt}`,
              },
              body: JSON.stringify(body),
            }),
          );
          if (response.status !== 200) throw new Error("The synthetic model refused a turn.");
          const events = (await response.text())
            .split("\n")
            .filter((line) => line.startsWith("data: "));
          for (const event of events) peer.send(event.slice(6));
        })().catch((error: unknown) => {
          fail(String(error));
          peer.close(1011);
        });
      });
    });
  });
  return {
    close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    },
  };
}
