import {
  isModelLifetimePath,
  modelLifetimeHeader,
  modelLifetimeProtocol,
} from "../model-lifetime-contract.ts";
import { SlotRefused, sameIdentity, type SlotIdentity } from "./contract.ts";

interface ControlEvents {
  message: { data: unknown };
  close: { code?: number };
  error: unknown;
}
export interface RuntimeControlSocket {
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof ControlEvents>(
    type: K,
    listener: (event: ControlEvents[K]) => void,
  ): void;
}
export type RuntimeControlPair = (headers: Headers) => {
  server: RuntimeControlSocket;
  response: Response;
};

interface Entry {
  identity: SlotIdentity;
  phase: "opening" | "ready" | "dispatched";
  stop(): void;
}

/** The private control channel owns endpoint activity; model frames stay natively coupled. */
export class RuntimeModelLifetimes {
  private entries = new Map<string, Entry>();
  private pair?: RuntimeControlPair;
  constructor(pair?: RuntimeControlPair) {
    this.pair = pair;
  }
  data(identity: SlotIdentity, request: Request, dispatch: () => Promise<Response>) {
    const id = request.headers.get(modelLifetimeHeader);
    if (
      !id ||
      isModelLifetimePath(new URL(request.url).pathname) ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    )
      return undefined;
    const entry = this.entries.get(id);
    if (!entry || entry.phase !== "ready" || !sameIdentity(entry.identity, identity))
      throw new SlotRefused("uncertain");
    entry.phase = "dispatched";
    return dispatch().catch((error: unknown) => {
      entry.stop();
      throw error;
    });
  }
  control(identity: SlotIdentity, request: Request, response: Response, release: () => void) {
    const id = request.headers.get(modelLifetimeHeader);
    const upstream: RuntimeControlSocket | null | undefined = Reflect.get(response, "webSocket");
    if (
      !id ||
      !/^[a-f0-9]{32}$/.test(id) ||
      this.entries.has(id) ||
      !this.pair ||
      response.status !== 101 ||
      !upstream ||
      response.headers.get("Sec-WebSocket-Protocol") !== modelLifetimeProtocol
    ) {
      try {
        upstream?.accept();
      } catch {}
      try {
        upstream?.close(1011, "Lifetime refused");
      } catch {}
      void response.body?.cancel().catch(() => {});
      throw new SlotRefused("uncertain");
    }
    const { server, response: forwarded } = this.pair(response.headers);
    let ended = false;
    const finish = (complete = false) => {
      if (ended) return;
      ended = true;
      this.entries.delete(id);
      request.signal.removeEventListener("abort", abort);
      for (const socket of [upstream, server])
        try {
          socket.close(complete ? 1000 : 1011, "Lifetime ended");
        } catch {}
      release();
    };
    const abort = () => finish();
    const retained: Entry = { identity, phase: "opening", stop: abort };
    this.entries.set(id, retained);
    upstream.addEventListener("message", (event) => {
      if (ended) return;
      try {
        if (retained.phase === "opening" && event.data === "ready") {
          retained.phase = "ready";
          server.send("ready");
        } else if (retained.phase === "dispatched" && event.data === "complete") {
          server.send("complete");
          finish(true);
        } else finish();
      } catch {
        finish();
      }
    });
    for (const socket of [upstream, server]) {
      socket.addEventListener("close", abort);
      socket.addEventListener("error", abort);
    }
    server.addEventListener("message", abort);
    server.accept();
    upstream.accept();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    return forwarded;
  }
}
