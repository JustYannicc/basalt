import {
  decodeTunnelResponseHeaders,
  tunnelResponseHeaderNames,
  decodeTunnelBytes,
  encodeTunnelBytes,
  tunnelLimits,
  normalizeModelSearch,
  type TunnelData,
  type TunnelOpen,
  type TunnelServerFrame,
} from "../../clients/contracts/tunnel.ts";
import { nativeModelRequest } from "../native-model.ts";
import type { TunnelEnvironment } from "./access.ts";
import { TunnelInput, TunnelOutput } from "./flow.ts";
import { upgradedSocket } from "./platform.ts";
import { TunnelWebSocket } from "./websocket.ts";

export class TunnelOperation {
  readonly output = new TunnelOutput();
  private abort = new AbortController();
  private input: TunnelInput | undefined;
  private socket: TunnelWebSocket | undefined;
  private reader: ReadableStreamBYOBReader | undefined;
  private stopped = false;
  private ended = false;
  private started = false;
  private open: TunnelOpen;
  private send: (frame: TunnelServerFrame) => void;
  private done: () => void;
  constructor(open: TunnelOpen, send: (frame: TunnelServerFrame) => void, done: () => void) {
    this.open = open;
    this.send = send;
    this.done = done;
    if (open.operation.transport === "http" && open.operation.method === "POST") {
      this.input = new TunnelInput((bytes) =>
        this.send({ v: 1, type: "credit", id: open.id, bytes }),
      );
    }
  }
  data(frame: TunnelData) {
    const bytes = decodeTunnelBytes(frame.bytes);
    if (this.socket) this.socket.receive(bytes, frame.text, frame.more === true);
    else {
      if (!this.input || frame.text || frame.more) throw new Error("Unexpected request data");
      this.input.push(bytes);
    }
  }
  end() {
    if (this.ended) throw new Error("Duplicate request end");
    this.ended = true;
    if (this.open.operation.transport === "websocket") this.stop();
    else this.input?.end();
  }
  private error(code: "unavailable" | "limit") {
    if (!this.stopped)
      this.send({
        v: 1,
        type: "error",
        id: this.open.id,
        code,
        outcome: this.started ? "unknown" : "not-started",
      });
    this.stop();
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.input?.abort();
    this.output.abort();
    this.socket?.stop();
    void this.reader?.cancel().catch(() => {});
    this.done();
  }
  async run(request: Request, env: TunnelEnvironment) {
    try {
      const headers = new Headers(this.open.headers);
      headers.set("authorization", request.headers.get("authorization")!);
      headers.set("accept-encoding", "identity");
      if (this.open.operation.transport === "websocket") headers.set("upgrade", "websocket");
      const url = new URL(this.open.operation.path, request.url);
      if (this.open.operation.service === "models" && this.open.operation.search !== undefined)
        url.search = normalizeModelSearch(this.open.operation.search);
      const target = new Request(url, {
        method: this.open.operation.method,
        headers,
        signal: this.abort.signal,
        redirect: "manual",
        ...(this.input ? { body: this.input.stream, duplex: "half" } : {}),
      });
      this.started = true;
      const response =
        this.open.operation.service === "models"
          ? await nativeModelRequest(target, env)
          : await env.TOOLS_SERVICE.fetch(target);
      if (this.stopped) {
        await response.body?.cancel();
        return;
      }
      if (this.open.operation.transport === "websocket" && response.status === 101) {
        const socket = upgradedSocket(response);
        if (!socket) throw new Error("Missing model socket");
        this.socket = new TunnelWebSocket(
          socket,
          this.open.id,
          this.output,
          this.send,
          () => this.error("limit"),
          () => {
            if (!this.stopped) this.send({ v: 1, type: "end", id: this.open.id });
            this.stop();
          },
        );
        this.send({ v: 1, type: "response", id: this.open.id, status: 101, headers: {} });
        this.send({ v: 1, type: "credit", id: this.open.id, bytes: tunnelLimits.windowBytes });
        return;
      }
      const allowed = new Set(tunnelResponseHeaderNames);
      const output: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (allowed.has(key)) output[key] = value;
      });
      const checked = decodeTunnelResponseHeaders(output);
      this.send({
        v: 1,
        type: "response",
        id: this.open.id,
        status: response.status,
        headers: checked,
      });
      if (response.body) {
        this.reader = response.body.getReader({ mode: "byob" });
        for (;;) {
          const capacity = await this.output.capacity();
          const next = await this.reader.read(new Uint8Array(capacity));
          if (next.done) break;
          let offset = 0;
          while (offset < next.value.length) {
            const size = Math.min(await this.output.capacity(), next.value.length - offset);
            this.output.take(size);
            this.send({
              v: 1,
              type: "data",
              id: this.open.id,
              bytes: encodeTunnelBytes(next.value.subarray(offset, offset + size)),
              text: false,
            });
            offset += size;
          }
        }
      }
      if (!this.stopped) this.send({ v: 1, type: "end", id: this.open.id });
      this.stop();
    } catch {
      this.error("unavailable");
    }
  }
  begin() {
    if (this.input)
      this.send({ v: 1, type: "credit", id: this.open.id, bytes: tunnelLimits.windowBytes });
  }
}
