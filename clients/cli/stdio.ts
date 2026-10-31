import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isInitializeRequest,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
} from "@modelcontextprotocol/sdk/types.js";
import { ipcFetch } from "./ipc.ts";
import { maximumRequestBytes } from "./http-forward.ts";

/** One transport bridge, with no tool catalog, policy, reconnect replay or second agent runtime. */
export async function bridgeStdio(socketPath: string, token: string): Promise<void> {
  const remote = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: ipcFetch(socketPath, token),
    requestInit: { redirect: "error" },
    reconnectionOptions: {
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const local = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: maximumRequestBytes,
  });
  let initialization: string | number | undefined;
  let pendingBytes = 0;
  let pending = 0;
  let closing = false;
  let failed = false;
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = async (failure = false) => {
    failed ||= failure;
    if (closing) return;
    closing = true;
    await Promise.allSettled([local.close(), remote.close()]);
    finish();
  };
  remote.onmessage = (message) => {
    if (
      isJSONRPCResultResponse(message) &&
      message.id === initialization &&
      typeof message.result.protocolVersion === "string"
    )
      remote.setProtocolVersion(message.result.protocolVersion);
    if (
      process.stdout.writableLength + Buffer.byteLength(JSON.stringify(message)) >
      maximumRequestBytes
    )
      return void close(true);
    void local.send(message).catch(() => close(true));
  };
  local.onmessage = (message) => {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (++pending > 32 || (pendingBytes += bytes) > maximumRequestBytes) return void close(true);
    if (isJSONRPCRequest(message) && isInitializeRequest(message)) initialization = message.id;
    if (pending > 8 || pendingBytes > 4 * 1024 * 1024) process.stdin.pause();
    void remote
      .send(message)
      .catch(() => close(true))
      .finally(() => {
        pending--;
        pendingBytes -= bytes;
        if (!closing && pending <= 8 && pendingBytes <= 4 * 1024 * 1024) process.stdin.resume();
      });
  };
  local.onerror = remote.onerror = () => {
    void close(true);
  };
  local.onclose = remote.onclose = () => {
    void close();
  };
  const end = () => {
    void close();
  };
  process.stdin.once("end", end);
  process.once("SIGTERM", end);
  process.once("SIGINT", end);
  try {
    await remote.start();
    await local.start();
    await ended;
    if (failed)
      throw new Error("The MCP connection ended. An interrupted call's outcome may be unknown.");
  } finally {
    process.stdin.off("end", end);
    process.off("SIGTERM", end);
    process.off("SIGINT", end);
    await close();
  }
}
