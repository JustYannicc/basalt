import assert from "node:assert/strict";
import { request, type ClientRequest } from "node:http";
import { connect as connectSocket } from "node:net";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { deferred } from "./remote-fixture.ts";

export const now = () => performance.timeOrigin + performance.now();
export type Protocol = "responses" | "messages" | "websocket";
export interface OperationRecord {
  id: string;
  gateway: string;
  protocol: Protocol;
  requestedAt: number;
  connectedAt?: number;
  headersAt?: number;
  firstByteAt?: number;
  terminalAt?: number;
  endedAt?: number;
  bytes: number;
  terminal: boolean;
  first: boolean;
  status?: number;
  error?: string;
}

export function startOperation(
  origin: string,
  token: string,
  input: {
    id: string;
    gateway: string;
    protocol: Protocol;
    slow: boolean;
    probe: boolean;
    thinkingMs: number;
    streamMs: number;
  },
  signal: AbortSignal,
) {
  const connected = deferred<void>();
  const record: OperationRecord = {
    ...input,
    requestedAt: now(),
    bytes: 0,
    terminal: false,
    first: false,
  };
  let local: ClientRequest | WebSocket | undefined;
  const inspect = (value: unknown) => {
    assert.ok(value && typeof value === "object" && "type" in value);
    const event = value as {
      type: string;
      response?: { id?: string; status?: string };
      message?: { id?: string };
    };
    if (!record.first) {
      assert.equal(
        event.type,
        input.protocol === "messages" ? "message_start" : "response.created",
      );
      assert.equal(
        input.protocol === "messages" ? event.message?.id : event.response?.id,
        input.id,
      );
      record.first = true;
    }
    if (event.type === (input.protocol === "messages" ? "message_stop" : "response.completed")) {
      assert.equal(record.terminal, false, "Duplicate protocol terminal.");
      if (input.protocol !== "messages") {
        assert.equal(event.response?.id, input.id);
        assert.equal(event.response.status, "completed");
      }
      record.terminal = true;
      record.terminalAt = now();
    }
  };
  const result = new Promise<OperationRecord>((resolve, reject) => {
    const finish = (error?: unknown) => {
      connected.resolve();
      record.endedAt = now();
      if (error) {
        record.error = error instanceof Error ? error.message : String(error);
        reject(Object.assign(new Error(record.error), { record }));
      } else {
        try {
          assert.equal(record.status, input.protocol === "websocket" ? 101 : 200);
          assert.equal(record.first, true, "Missing first protocol event.");
          assert.equal(
            record.terminal,
            true,
            "A successful transport ended without its protocol terminal.",
          );
          resolve(record);
        } catch (error) {
          reject(Object.assign(error as Error, { record }));
        }
      }
    };
    const path = input.protocol === "messages" ? "/v1/messages" : "/v1/responses";
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-scale-id": input.id,
    };
    if (input.protocol === "websocket") {
      const target = new URL(origin);
      const socket = new WebSocket(origin.replace("http:", "ws:") + path, {
        headers,
        handshakeTimeout: 90_000,
        createConnection: () => {
          const connection = connectSocket({ host: target.hostname, port: Number(target.port) });
          connection.once("connect", () => {
            record.connectedAt = now();
            connected.resolve();
          });
          return connection;
        },
      });
      local = socket;
      const abort = () => socket.terminate();
      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        record.headersAt = now();
        record.status = 101;
        connected.resolve();
        socket.send(
          JSON.stringify({ ...input, type: "response.create", model: "synthetic", stream: true }),
        );
      });
      socket.on("message", (bytes) => {
        try {
          record.firstByteAt ??= now();
          record.bytes += Buffer.byteLength(bytes.toString());
          inspect(JSON.parse(bytes.toString()));
          if (record.terminal) socket.close();
        } catch (error) {
          socket.terminate();
          finish(error);
        }
      });
      socket.once("error", finish);
      socket.once("close", () => {
        signal.removeEventListener("abort", abort);
        finish();
      });
      if (signal.aborted) abort();
    } else {
      let buffer = "";
      const client = request(
        origin + path,
        { method: "POST", agent: false, headers, signal },
        (response) => {
          record.status = response.statusCode;
          record.headersAt = now();
          let slow = input.slow;
          response.on("data", (bytes: Buffer) => {
            try {
              record.firstByteAt ??= now();
              record.bytes += bytes.length;
              buffer += bytes.toString();
              assert.ok(buffer.length < 128 * 1024, "Unbounded protocol parser buffer.");
              for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline < 0) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line.startsWith("data: ")) inspect(JSON.parse(line.slice(6)));
              }
              if (slow) {
                slow = false;
                response.pause();
                const timer = setTimeout(() => response.resume(), 5000);
                response.once("close", () => clearTimeout(timer));
              }
            } catch (error) {
              client.destroy();
              finish(error);
            }
          });
          response.once("error", finish);
          response.once("end", () => finish());
        },
      );
      local = client;
      client.once("socket", (socket) =>
        socket.once("connect", () => {
          record.connectedAt = now();
          connected.resolve();
        }),
      );
      client.once("error", finish);
      client.end(JSON.stringify({ ...input, model: "synthetic", stream: true }));
    }
  });
  // A failure may precede the caller awaiting completion while it establishes the other sockets.
  void result.catch(() => undefined);
  return {
    connected: connected.promise,
    result,
    close: () => (local instanceof WebSocket ? local.terminate() : local?.destroy()),
  };
}
