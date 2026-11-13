import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer, type RawData } from "ws";
import type { TunnelAccess, TunnelEnvironment } from "../../src/tunnel/access.ts";
import type { TunnelLimits } from "../contracts/tunnel.ts";
import type { TunnelTiming } from "../../src/tunnel/timing.ts";
import type { TunnelSocket } from "../../src/tunnel/platform.ts";
import { openTunnel } from "../connection/tunnel.ts";
import { deviceSocket } from "../cli/device-socket.ts";
import { forwardTunnelWebsocket } from "../cli/tunnel-forward.ts";
import type { ConnectionTransport } from "../contracts/connection.ts";
import { deferred } from "./remote-fixture.ts";

// Keep server app types out of the independently installed client test project.
const sessionModule = "../../src/tunnel/session.ts";
const {
  serveTunnel,
}: {
  serveTunnel(
    socket: TunnelSocket,
    lease: TunnelSocket,
    request: Request,
    env: TunnelEnvironment,
    access: TunnelAccess,
    keepAlive: (work: Promise<unknown>) => void,
    timing?: TunnelTiming,
    limits?: TunnelLimits,
  ): void;
} = await import(sessionModule);

const legacyLimits = {
  frameBytes: 32768,
  chunkBytes: 16384,
  windowBytes: 65536,
  requestBytes: 16777216,
  websocketRequestBytes: 1048576,
  operations: 16,
  sessionMilliseconds: 600000,
} as const;

class ModelPeer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  closed = false;
  messages: (string | ArrayBuffer)[] = [];
  received = deferred<void>();
  fullWindow = deferred<void>();
  paused = false;
  pending: ArrayBuffer[] = [];
  private framed: boolean;
  constructor(framed = false) {
    super();
    this.framed = framed;
  }
  accept() {}
  send(data: Parameters<TunnelSocket["send"]>[0]) {
    if (typeof data !== "string" && !(data instanceof ArrayBuffer))
      throw new Error("Invalid fixture message.");
    if (!this.framed) {
      this.messages.push(data);
      this.received.resolve();
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data })));
      return;
    }
    if (!(data instanceof ArrayBuffer)) throw new Error("Expected private consumer frame.");
    this.pending.push(data);
    if (this.pending.reduce((sum, frame) => sum + frame.byteLength - 5, 0) >= 65_536)
      this.fullWindow.resolve();
    queueMicrotask(() => this.consume());
  }
  consume() {
    if (this.paused || this.closed) return;
    for (const data of this.pending.splice(0)) {
      const frame = new Uint8Array(data),
        body = frame.subarray(5);
      const sequence = new DataView(data).getUint32(1);
      this.messages.push(frame[0] === 0 ? new TextDecoder().decode(body) : body.slice().buffer);
      this.received.resolve();
      const ack = new Uint8Array(9);
      ack[0] = 2;
      const view = new DataView(ack.buffer);
      view.setUint32(1, sequence);
      view.setUint32(5, body.length);
      this.dispatchEvent(new MessageEvent("message", { data: ack.buffer }));
      const output = new Uint8Array(1 + body.length);
      output[0] = frame[0]!;
      output.set(body, 1);
      this.dispatchEvent(new MessageEvent("message", { data: output.buffer }));
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}
const bytes = (data: RawData) =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : data;

/** Real local bridge and tunnel; only authority and the final model socket are synthetic. */
export async function envelopeFixture(legacyOnly = false) {
  const protocols: string[] = [];
  const models: ModelPeer[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  const controller = new AbortController();
  const access = {
    id: "native:synthetic",
    userId: "synthetic",
    clientId: "synthetic",
    expiresAt: Date.now() + 3_600_000,
    policy: { kind: "native", computer: "synthetic", pool: "synthetic", models: true },
  } as const;
  const server = createServer();
  server.on("upgrade", (request, connection, head) => {
    const protocol = request.headers["sec-websocket-protocol"];
    protocols.push(String(protocol));
    if (protocol !== "basalt.tunnel.v1" && (legacyOnly || protocol !== "basalt.tunnel.v2")) {
      connection.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, connection, head, (peer) => {
      const events = new EventTarget();
      peer.on("message", (data, binary) => {
        const value = bytes(data);
        events.dispatchEvent(
          new MessageEvent("message", {
            data: binary
              ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
              : value.toString(),
          }),
        );
      });
      peer.on("close", () => events.dispatchEvent(new Event("close")));
      peer.on("error", () => events.dispatchEvent(new Event("error")));
      const socket: TunnelSocket = {
        binaryType: "arraybuffer",
        accept() {},
        send: (data) => {
          peer.send(data);
        },
        close: () => {
          peer.close();
        },
        addEventListener: events.addEventListener.bind(events),
      };
      serveTunnel(
        socket,
        new ModelPeer(),
        new Request("https://synthetic.invalid/native/v1/tunnel", {
          headers: { authorization: "Bearer synthetic" },
          signal: controller.signal,
        }),
        {
          POOL_APP_SIGNING_KEY: "ab".repeat(32),
          TOOLS_SERVICE: { fetch: async () => Response.json(access) },
          POOL_SERVICE: {
            fetch: async () => {
              const model = new ModelPeer(protocol === "basalt.tunnel.v2");
              models.push(model);
              const response = new Response(null);
              if (protocol === "basalt.tunnel.v2")
                response.headers.set("sec-websocket-protocol", "basalt.model-drain.v1");
              Object.defineProperties(response, {
                status: { value: 101 },
                webSocket: { value: model },
              });
              return response;
            },
          },
        },
        access,
        (work) => {
          void work;
        },
        undefined,
        protocol === "basalt.tunnel.v2"
          ? { ...legacyLimits, websocketMessageBytes: 16777216 }
          : legacyLimits,
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port.");
  const tunnelUrl = `ws://127.0.0.1:${address.port}/native/v1/tunnel`;
  const transport: Extract<ConnectionTransport, { mode: "device" }> = {
    mode: "device",
    capabilities: ["models"],
    open: (request, signal) => openTunnel(deviceSocket(tunnelUrl, "synthetic"), request, signal),
  };
  const bridge = createServer();
  const pending = new Set<Promise<void>>();
  bridge.on("upgrade", (request, socket, head) => {
    const work = forwardTunnelWebsocket(request, socket, head, transport, controller.signal)
      .catch(() => {
        socket.destroy();
      })
      .finally(() => pending.delete(work));
    pending.add(work);
  });
  bridge.listen(0, "127.0.0.1");
  await once(bridge, "listening");
  const local = bridge.address();
  if (!local || typeof local === "string") throw new Error("Missing bridge port.");
  return {
    origin: `ws://127.0.0.1:${local.port}/v1/responses`,
    tunnelUrl,
    protocols,
    models,
    close: async () => {
      controller.abort();
      for (const peer of sockets.clients) peer.terminate();
      await Promise.all(pending);
      sockets.close();
      await Promise.all(
        [server, bridge].map((item) => new Promise<void>((resolve) => item.close(() => resolve()))),
      );
    },
  };
}
