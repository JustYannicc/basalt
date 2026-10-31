import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { CredentialSource, Profile } from "../contracts/connection.ts";
import {
  bearerToken,
  findAgent,
  localRequest,
  remoteOperation,
  tokenMatches,
} from "./local-access.ts";
import { forwardHttp, maximumRequestBytes } from "./http-forward.ts";
import { forwardWebsocket } from "./websocket-forward.ts";

export interface GatewayOptions {
  readonly profile: () => Promise<Profile>;
  readonly source: CredentialSource;
  readonly operatorHash: string;
  readonly ipcPath: string;
  readonly port: number;
}

function answer(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export async function startGateway(options: GatewayOptions) {
  const active = new Set<AbortController>();
  let closed = false;
  let transition: Promise<void> = Promise.resolve();
  const interrupt = () => {
    for (const controller of active) controller.abort();
  };
  const handle = async (request: IncomingMessage, response: ServerResponse, authority: string) => {
    response.on("error", () => undefined);
    if (!localRequest(request, authority))
      return answer(response, 403, { error: "Local request refused." });
    if (closed) return answer(response, 503, { error: "The connection is stopping." });
    if (request.url?.startsWith("/client/")) {
      if (!tokenMatches(bearerToken(request), options.operatorHash))
        return answer(response, 401, { error: "An operator credential is required." });
      if (request.method === "GET" && request.url === "/client/status")
        return answer(response, 200, options.source.view());
      const command = request.url.slice("/client/".length);
      if (
        request.method !== "POST" ||
        !["disconnect", "reconnect", "sign-out", "revoke"].includes(command)
      )
        return answer(response, 404, { error: "Unknown connection command." });
      if (request.headers["content-length"] && request.headers["content-length"] !== "0")
        return answer(response, 400, { error: "This command takes no body." });
      interrupt();
      const work = async () => {
        if (command === "disconnect") await options.source.disconnect();
        if (command === "reconnect") await options.source.reconnect();
        if (command === "sign-out") await options.source.signOut();
        if (command === "revoke") await options.source.revoke();
      };
      const result = transition.then(work);
      transition = result.catch(() => undefined);
      try {
        await result;
        return answer(response, 200, options.source.view());
      } catch {
        return answer(response, 409, { error: "The connection command could not finish." });
      }
    }
    const capability = remoteOperation(request.method, request.url ?? "");
    if (!capability) return answer(response, 404, { error: "This endpoint is not available." });
    const profile = await options.profile();
    if (!findAgent(request, profile.agents, capability))
      return answer(response, 401, { error: "An agent credential for this service is required." });
    if (Number(request.headers["content-length"] ?? 0) > maximumRequestBytes)
      return answer(response, 413, { error: "The request exceeds the local size limit." });
    if (active.size >= 32)
      return answer(response, 503, {
        error: "The connection is busy. Retry when a request finishes.",
      });
    const controller = new AbortController();
    const cancel = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once("close", cancel);
    request.once("aborted", () => controller.abort());
    active.add(controller);
    try {
      await transition;
      const credentials = await options.source.credentials(controller.signal);
      const service = credentials[capability];
      if (!service)
        return answer(response, 403, { error: "This connection has no access to this service." });
      await forwardHttp(request, response, service, capability, controller.signal);
    } catch {
      if (!response.headersSent && !response.destroyed)
        answer(response, 502, {
          error: "The request was interrupted. Its outcome may be unknown; it was not replayed.",
        });
      else response.destroy();
    } finally {
      active.delete(controller);
      response.off("close", cancel);
    }
  };
  let authority = "";
  const tcp = createServer((request, response) => {
    void handle(request, response, authority).catch(() => {
      if (!response.headersSent)
        answer(response, 503, { error: "Connection state is unavailable." });
      else response.destroy();
    });
  });
  tcp.on("upgrade", (request, socket, head) => {
    const forward = async () => {
      if (
        !localRequest(request, authority) ||
        request.url !== "/v1/responses" ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        closed ||
        active.size >= 32
      )
        return socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      const profile = await options.profile();
      if (!findAgent(request, profile.agents, "models"))
        return socket.end(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      const controller = new AbortController();
      active.add(controller);
      const cancel = () => controller.abort();
      socket.once("close", cancel);
      try {
        await transition;
        const credentials = await options.source.credentials(controller.signal);
        if (!credentials.models)
          return socket.end(
            "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        await forwardWebsocket(request, socket, head, credentials.models, controller.signal);
      } finally {
        active.delete(controller);
        socket.off("close", cancel);
      }
    };
    void forward().catch(() => socket.destroy());
  });
  const ipc = createServer((request, response) => {
    void handle(request, response, "localhost").catch(() => {
      if (!response.headersSent)
        answer(response, 503, { error: "Connection state is unavailable." });
      else response.destroy();
    });
  });
  for (const server of [tcp, ipc]) {
    server.maxHeadersCount = 40;
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    server.on("clientError", (_error, socket) => socket.destroy());
  }
  const listen = (server: typeof tcp, target: { host: string; port: number } | { path: string }) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(target, () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(tcp, { host: "127.0.0.1", port: options.port });
    authority = `127.0.0.1:${(tcp.address() as AddressInfo).port}`;
    await listen(ipc, { path: options.ipcPath });
    if (process.platform !== "win32") await chmod(options.ipcPath, 0o600);
  } catch (error) {
    tcp.closeAllConnections();
    tcp.close();
    ipc.close();
    throw error;
  }
  return {
    origin: `http://127.0.0.1:${(tcp.address() as AddressInfo).port}`,
    close: async () => {
      closed = true;
      interrupt();
      await Promise.all(
        [tcp, ipc].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
      if (process.platform !== "win32") await rm(options.ipcPath, { force: true });
    },
  };
}
