import type { NativeStreamLease } from "./native-streams.ts";

import {
  modelLifetimeProtocol,
  modelLifetimePath,
  modelLifetimeHeader,
} from "./model-lifetime-contract.ts";

interface LifetimeSocket extends Pick<
  WebSocket,
  "addEventListener" | "removeEventListener" | "close"
> {
  accept(): void;
}

const lifetimes = new WeakMap<Response, ModelLifetime>();

class ModelLifetime {
  private ended = false;
  private completed = false;
  private cancelled = false;
  private phase: "opening" | "ready" | "dispatched" = "opening";
  private releases = new Set<(known: boolean, cancelled: boolean) => void>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => {
    this.resolveReady = resolve;
    this.rejectReady = reject;
  });
  private control: LifetimeSocket;
  private abortSocket: AbortController;
  private signal: AbortSignal;
  constructor(control: LifetimeSocket, abortSocket: AbortController, signal: AbortSignal) {
    this.control = control;
    this.abortSocket = abortSocket;
    this.signal = signal;
    control.addEventListener("message", this.message);
    control.addEventListener("close", this.abort);
    control.addEventListener("error", this.abort);
    signal.addEventListener("abort", this.cancel, { once: true });
  }
  accept() {
    this.control.accept();
    if (this.signal.aborted) this.cancel();
  }
  private message = (event: { data: unknown }) => {
    if (this.phase === "opening" && event.data === "ready") {
      this.phase = "ready";
      this.resolveReady();
    } else if (this.phase === "dispatched" && event.data === "complete") this.finish(true);
    else this.abort();
  };
  private finish(known: boolean, cancelled = false) {
    if (this.ended) return;
    this.ended = true;
    this.completed = known;
    this.cancelled = cancelled;
    this.signal.removeEventListener("abort", this.cancel);
    this.control.removeEventListener("message", this.message);
    this.control.removeEventListener("close", this.abort);
    this.control.removeEventListener("error", this.abort);
    if (!known) {
      this.abortSocket.abort();
      this.rejectReady(new Error("Model socket lifetime is unavailable"));
    }
    try {
      this.control.close(1000, "Lifetime ended");
    } catch {}
    for (const release of this.releases) release(known, cancelled);
    this.releases.clear();
  }
  abort = () => this.finish(false);
  private cancel = () => this.finish(false, true);
  discard() {
    this.finish(true);
  }
  dispatch() {
    if (this.ended || this.phase !== "ready")
      throw new Error("Model socket lifetime is unavailable");
    this.phase = "dispatched";
  }
  bind(lease: NativeStreamLease) {
    const release = (known: boolean, cancelled: boolean) => {
      lease.signal.removeEventListener("abort", this.cancel);
      if (known || cancelled || !lease.failed) {
        lease.release();
        return;
      }
      try {
        // A failed durable fence must retain the reservation even after its socket closes.
        void Promise.resolve(lease.failed(new Error("Model socket lifetime is unavailable"))).then(
          () => lease.release(),
          () => {},
        );
      } catch {}
    };
    if (this.ended) {
      release(this.completed, this.cancelled);
      return;
    }
    this.releases.add(release);
    lease.signal.addEventListener("abort", this.cancel, { once: true });
    lease.onClose(this.cancel);
    if (lease.signal.aborted) this.cancel();
  }
}

export async function modelLifetimeFetch(
  request: Request,
  forward: (request: Request) => Promise<Response>,
  beforeDispatch: () => void = () => {},
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    beforeDispatch();
    return forward(request);
  }
  request.signal.throwIfAborted();
  const abortSocket = new AbortController();
  const signal = AbortSignal.any([request.signal, abortSocket.signal]);
  const id = crypto.randomUUID().replaceAll("-", "");
  const headers = new Headers(request.headers);
  headers.set(modelLifetimeHeader, id);
  const controlHeaders = new Headers(headers);
  controlHeaders.set("Sec-WebSocket-Protocol", modelLifetimeProtocol);
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"])
    controlHeaders.delete(name);
  const url = new URL(request.url);
  url.pathname = modelLifetimePath;
  // Deleting while iterating live keys skips entries, so take a snapshot first.
  for (const name of Array.from(url.searchParams.keys()))
    if (name !== "key" && name !== "auth_token") url.searchParams.delete(name);
  const control = await forward(new Request(url, { headers: controlHeaders, signal }));
  if (
    !upgraded(control) ||
    control.headers.get("Sec-WebSocket-Protocol") !== modelLifetimeProtocol
  ) {
    if (upgraded(control)) {
      try {
        control.webSocket.accept();
      } catch {}
      try {
        control.webSocket.close(1000, "Lifetime unavailable");
      } catch {}
    } else await control.body?.cancel();
    throw new Error("Model socket lifetime is unavailable");
  }
  const lifetime = new ModelLifetime(control.webSocket, abortSocket, request.signal);
  try {
    lifetime.accept();
    await lifetime.ready;
    lifetime.dispatch();
    beforeDispatch();
    const response = await forward(new Request(request, { headers, signal }));
    if (upgraded(response)) lifetimes.set(response, lifetime);
    else lifetime.discard();
    return response;
  } catch (error) {
    lifetime.abort();
    throw error;
  }
}

export function bindModelLifetime(response: Response, lease: NativeStreamLease) {
  const lifetime = lifetimes.get(response);
  if (!lifetime) return false;
  lifetime.bind(lease);
  return true;
}

export function inheritModelLifetime(source: Response, target: Response) {
  const lifetime = lifetimes.get(source);
  if (lifetime) lifetimes.set(target, lifetime);
  return target;
}

function upgraded(response: Response): response is Response & { webSocket: LifetimeSocket } {
  return response.status === 101 && "webSocket" in response && response.webSocket != null;
}
