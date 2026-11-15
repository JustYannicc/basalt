import { WebSocket, WebSocketPair } from "miniflare";
import {
  modelLifetimeHeader,
  modelLifetimePath,
  modelLifetimeProtocol,
} from "../../src/pool/model-lifetime-contract.ts";

/** Synthetic native listener: completion is separate from model frame forwarding. */
export class ModelLifetimeFixture {
  private entries = new Map<string, { control: WebSocket; data?: WebSocket; complete?(): void }>();
  fetch(request: Request, open: (server: WebSocket) => void = () => {}) {
    const id = request.headers.get(modelLifetimeHeader);
    if (!id) return new Response(null, { status: 403 });
    if (new URL(request.url).pathname === modelLifetimePath) {
      if (this.entries.has(id)) return new Response(null, { status: 409 });
      const pair = new WebSocketPair();
      pair[1].accept();
      const entry: { control: WebSocket; data?: WebSocket; complete?(): void } = {
        control: pair[1],
      };
      this.entries.set(id, entry);
      pair[1].addEventListener("close", () => {
        try {
          entry.data?.close(1011, "Control ended");
        } catch {}
        this.entries.delete(id);
      });
      pair[1].send("ready");
      const init = {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": modelLifetimeProtocol },
      };
      return new Response(null, init);
    }
    const entry = this.entries.get(id);
    if (!entry || entry.data) return new Response(null, { status: 409 });
    const pair = new WebSocketPair();
    pair[1].accept();
    entry.data = pair[1];
    let ended = false;
    const complete = () => {
      if (ended) return;
      ended = true;
      try {
        entry.control.send("complete");
        entry.control.close(1000, "Complete");
      } catch {}
      this.entries.delete(id);
    };
    entry.complete = complete;
    pair[1].addEventListener("close", complete);
    pair[1].addEventListener("error", complete);
    open(pair[1]);
    const init = { status: 101, webSocket: pair[0] };
    return new Response(null, init);
  }
  complete(server: WebSocket) {
    for (const entry of this.entries.values())
      if (entry.data === server) {
        server.close(1000, "Protocol terminal");
        entry.complete?.();
        return;
      }
    throw new Error("Unknown synthetic native socket");
  }
  breakControl(invalid = false) {
    for (const entry of this.entries.values())
      if (invalid) entry.control.send("invalid");
      else entry.control.close(1011, "Control failed");
  }
  close() {
    for (const entry of this.entries.values())
      for (const socket of [entry.control, entry.data])
        try {
          socket?.close();
        } catch {}
    this.entries.clear();
  }
}
