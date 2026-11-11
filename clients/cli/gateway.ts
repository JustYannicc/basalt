import {
  upstreamOutcomeUnknown,
  ModelRequestNotSent,
  LocalRequestRefused,
} from "../contracts/model-error.ts";
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
import { forwardTunnelHttp, forwardTunnelWebsocket } from "./tunnel-forward.ts";
import { connectionHealth } from "./connection-health.ts";
import { StartQueue } from "./start-queue.ts";

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
  const health = connectionHealth(options.source);
  const active = new Set<AbortController>();
  const starts = new StartQueue();
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
        return answer(response, 200, health.view());
      if (request.method === "GET" && request.url === "/client/health")
        return answer(response, 200, await health.check());
      if (request.method === "GET" && request.url === "/client/apps") {
        // Disconnect, sign-out and a closed caller interrupt the read like forwarded requests.
        const controller = new AbortController();
        const cancel = () => controller.abort();
        response.once("close", cancel);
        active.add(controller);
        try {
          const summary = await options.source.apps(
            AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          );
          return answer(response, 200, summary ?? null);
        } catch {
          return answer(response, 409, { error: "The app list is unavailable." });
        } finally {
          response.off("close", cancel);
          active.delete(controller);
        }
      }
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
        health.reset(command === "disconnect");
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
    if (closed) return answer(response, 503, { error: "The connection is stopping." });
    if (!findAgent(request, profile.agents, capability))
      return answer(response, 401, { error: "An agent credential for this service is required." });
    if (Number(request.headers["content-length"] ?? 0) > maximumRequestBytes)
      return answer(response, 413, { error: "The request exceeds the local size limit." });
    const controller = new AbortController();
    const cancel = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once("close", cancel);
    request.once("aborted", () => controller.abort());
    active.add(controller);
    let dispatched = false;
    let ready: (() => void) | undefined;
    try {
      ready = await starts.acquire(controller.signal);
      controller.signal.throwIfAborted();
      await transition;
      const transport = await options.source.transport(controller.signal);
      if (transport.mode === "device") {
        if (!transport.capabilities.includes(capability))
          return answer(response, 403, { error: "This connection has no access to this service." });
        dispatched = true;
        await forwardTunnelHttp(request, response, transport, capability, controller.signal, ready);
      } else {
        const service = transport.credentials[capability];
        if (!service)
          return answer(response, 403, { error: "This connection has no access to this service." });
        dispatched = true;
        await forwardHttp(request, response, service, capability, controller.signal, ready);
      }
    } catch (error) {
      if (dispatched && error instanceof ModelRequestNotSent)
        await options.source.transport(controller.signal).catch(() => undefined);
      if (response.headersSent || response.destroyed) response.destroy();
      else if (error instanceof LocalRequestRefused) {
        response.setHeader("x-should-retry", "false");
        return answer(response, 502, { error: "The local request was refused before dispatch." });
      } else if (!dispatched || error instanceof ModelRequestNotSent) {
        if (["sign-in-required", "revoked"].includes(options.source.view().state))
          return answer(response, 401, { error: "Sign in again before using this device." });
        response.setHeader("Retry-After", "1");
        return answer(
          response,
          503,
          capability === "models"
            ? { error: "Model access is unavailable." }
            : {
                jsonrpc: "2.0",
                id: null,
                error: {
                  code: -32000,
                  message: "Tools are temporarily unavailable. Nothing was sent. Retry shortly.",
                  data: { retryable: true },
                },
              },
        );
      } else if (capability === "models") {
        const failure = upstreamOutcomeUnknown();
        failure.headers.forEach((value, name) => response.setHeader(name, value));
        response.writeHead(failure.status);
        response.end(await failure.text());
      } else
        answer(response, 502, {
          error: "The request was interrupted. Its outcome may be unknown; it was not replayed.",
        });
    } finally {
      ready?.();
      active.delete(controller);
      response.off("close", cancel);
    }
  };
  const origin = new URL("http://127.0.0.1");
  let authority = "";
  const tcp = createServer((request, response) => {
    void handle(request, response, authority).catch(() => {
      if (!response.headersSent)
        answer(response, 503, { error: "Connection state is unavailable." });
      else response.destroy();
    });
  });
  tcp.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const forward = async () => {
      if (
        !localRequest(request, authority) ||
        remoteOperation(request.method, request.url ?? "", true) !== "models" ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        closed
      )
        return socket.end(
          "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      const profile = await options.profile();
      if (socket.destroyed) return;
      if (!findAgent(request, profile.agents, "models"))
        return socket.end(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      if (closed)
        return socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
      const controller = new AbortController();
      active.add(controller);
      const cancel = () => controller.abort();
      socket.once("close", cancel);
      let ready: (() => void) | undefined;
      let dispatched = false;
      try {
        ready = await starts.acquire(controller.signal);
        controller.signal.throwIfAborted();
        await transition;
        const transport = await options.source.transport(controller.signal);
        if (transport.mode === "device") {
          if (!transport.capabilities.includes("models"))
            return socket.end(
              "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
          dispatched = true;
          await forwardTunnelWebsocket(request, socket, head, transport, controller.signal, ready);
        } else {
          if (!transport.credentials.models)
            return socket.end(
              "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
            );
          dispatched = true;
          await forwardWebsocket(
            request,
            socket,
            head,
            transport.credentials.models,
            controller.signal,
            ready,
          );
        }
      } catch {
        if (!dispatched && !socket.destroyed)
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        else socket.destroy();
      } finally {
        ready?.();
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
      // macOS still clamps this to kern.ipc.somaxconn, which defaults to 128.
      server.listen({ ...target, backlog: 511 }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(tcp, { host: "127.0.0.1", port: options.port });
    origin.port = String((tcp.address() as AddressInfo).port);
    authority = origin.host;
    await listen(ipc, { path: options.ipcPath });
    if (process.platform !== "win32") await chmod(options.ipcPath, 0o600);
  } catch (error) {
    tcp.closeAllConnections();
    tcp.close();
    ipc.close();
    throw error;
  }
  return {
    origin: origin.origin,
    close: async () => {
      closed = true;
      interrupt();
      await health.close();
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
