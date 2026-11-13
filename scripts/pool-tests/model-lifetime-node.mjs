import { DurableObject } from "cloudflare:workers";
import { dispatchTimingHeader } from "../../src/pool/dispatch-timing.ts";
const protocol = "basalt.model-lifetime.v1";
const lifetimePath = "/v1/__basalt/model-lifetime";
const lifetimeHeader = "x-basalt-model-lifetime-id";

export class ModelLifetimeNode extends DurableObject {
  entries = new Map();
  dispatches = 0;
  closed = 0;
  closedBoots = [];
  waiters = new Set();
  mode = "ready";
  async fetch(request) {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/node-mode") {
      this.mode = url.searchParams.get("mode");
      return new Response(null, { status: 204 });
    }
    if (path === "/node-break") {
      for (const entry of this.entries.values()) entry.control.close(1000, "lost");
      return new Response(null, { status: 204 });
    }
    if (path === "/node-broadcast") {
      const message = await request.text();
      for (const entry of this.entries.values()) entry.data?.send(message);
      return new Response(null, { status: 204 });
    }
    if (path === "/node-wait-closed") {
      const count = Number(url.searchParams.get("count"));
      if (this.closed < count) await new Promise((resolve) => this.waiters.add({ count, resolve }));
      return Response.json({ upstreamClosed: this.closed });
    }
    const id = request.headers.get(lifetimeHeader);
    if (path === lifetimePath) {
      if (!id || this.entries.has(id) || request.headers.get("Sec-WebSocket-Protocol") !== protocol)
        return new Response(null, { status: 403 });
      const pair = new WebSocketPair();
      pair[1].accept();
      const entry = { control: pair[1], data: undefined };
      this.entries.set(id, entry);
      const stop = () => {
        entry.data?.close(1011, "Control ended");
        this.entries.delete(id);
      };
      pair[1].addEventListener("close", stop);
      pair[1].addEventListener("error", stop);
      pair[1].addEventListener("message", stop);
      pair[1].send(this.mode === "ready" ? "ready" : "invalid");
      return new Response(null, {
        status: 101,
        webSocket: pair[0],
        headers: { "Sec-WebSocket-Protocol": protocol },
      });
    }
    if (path === "/node-state")
      return Response.json({
        dispatches: this.dispatches,
        lifetimes: this.entries.size,
        closed: this.closed,
        closedBoots: this.closedBoots,
      });
    const entry =
      this.entries.get(id) ??
      (!id && url.searchParams.has("unleased")
        ? { control: undefined, data: undefined }
        : undefined);
    if (!entry || entry.data) return new Response(null, { status: 409 });
    this.dispatches++;
    const pair = new WebSocketPair();
    pair[1].binaryType = "arraybuffer";
    pair[1].accept();
    entry.data = pair[1];
    let ended = false;
    const complete = () => {
      if (ended) return;
      ended = true;
      this.closed++;
      const boot = request.headers.get("X-Fixture-Boot");
      if (boot) this.closedBoots.push(boot);
      for (const waiter of this.waiters)
        if (this.closed >= waiter.count) {
          waiter.resolve();
          this.waiters.delete(waiter);
        }
      try {
        entry.control?.send("complete");
        entry.control?.close(1000, "complete");
      } catch {}
      this.entries.delete(id);
    };
    pair[1].addEventListener("close", complete);
    pair[1].addEventListener("error", complete);
    pair[1].addEventListener("message", (event) => {
      if (event.data === "finish") pair[1].close(1000, "done");
      else if (event.data === "upstream-close") pair[1].close(1011, "upstream ended");
      else pair[1].send(event.data);
    });
    const boot = request.headers.get("X-Fixture-Boot");
    if (boot) pair[1].send(boot);
    const headers = new Headers({ [dispatchTimingHeader]: "fixture" });
    const offered = request.headers.get("Sec-WebSocket-Protocol");
    if (offered) headers.set("Sec-WebSocket-Protocol", offered);
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }
}
