import { ModelRequestNotSent } from "../contracts/model-error.ts";
import {
  decodeTunnelBytes,
  decodeTunnelFrame,
  encodeTunnelBytes,
  tunnelLimits,
  type TunnelClientFrame,
  type TunnelData,
  type TunnelServerFrame,
} from "../contracts/tunnel.ts";
import type {
  ClientOperation,
  OpenOperation,
  TunnelPart,
  WireSocket,
} from "../contracts/transport.ts";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Each operation owns its socket, so a failed call cannot be replayed by session recovery. */
export function openTunnel(
  socket: WireSocket,
  open: OpenOperation,
  signal: AbortSignal,
): ClientOperation {
  const response = deferred<Extract<TunnelServerFrame, { type: "response" }>>();
  const ready = deferred<void>();
  const queue: TunnelPart[] = [];
  let stopped = false,
    ended = false,
    started = false,
    responded = false,
    inputEnded = false,
    notStarted = false;
  let failure: Error | undefined,
    queued = 0,
    available = 0,
    outstanding = 0,
    initialized = false;
  let outputCredit: number = tunnelLimits.windowBytes;
  let acknowledged = 0,
    sent = 0;
  let wake: (() => void) | undefined, wakeSend: (() => void) | undefined;
  const send = (frame: TunnelClientFrame) => {
    if (stopped) throw failure ?? new Error("Tunnel interrupted; operation was not replayed.");
    socket.send(JSON.stringify(frame));
  };
  const fail = () => {
    if (stopped || ended) return;
    failure = !started || notStarted ? new ModelRequestNotSent("The operation was refused before dispatch.") : new Error(
      "Tunnel interrupted; the outcome may be unknown. The operation was not replayed.",
    );
    stopped = true;
    ready.reject(failure);
    response.reject(failure);
    wake?.();
    wakeSend?.();
    cleanup();
    socket.close();
  };
  const timer = setTimeout(fail, 30_000);
  const cleanup = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", fail);
    unlisten();
  };
  const unlisten = socket.listen((event) => {
    if (stopped || ended) return;
    if (event.type !== "message") return fail();
    try {
      if (typeof event.data !== "string") throw new Error("Expected tunnel text frame.");
      const frame = decodeTunnelFrame(event.data, "server");
      if (frame.type === "ready") {
        if (
          started ||
          frame.expiresAt <= Date.now() ||
          Object.entries(tunnelLimits).some(
            ([key, value]) => frame.limits[key as keyof typeof tunnelLimits] !== value,
          )
        )
          throw new Error("Incompatible tunnel session.");
        started = true;
        send({ v: 1, type: "open", id: 1, ...open });
        send({ v: 1, type: "credit", id: 1, bytes: tunnelLimits.windowBytes });
        ready.resolve();
        return;
      }
      if (!started || frame.id !== 1) throw new Error("Unexpected operation.");
      if (frame.type === "response") {
        if (responded) throw new Error("Duplicate response.");
        if (frame.status === 101 && open.operation.transport !== "websocket")
          throw new Error("Unexpected upgrade.");
        responded = true;
        clearTimeout(timer);
        response.resolve(frame);
      } else if (frame.type === "credit") {
        if (
          (initialized && frame.bytes > outstanding) ||
          available + frame.bytes > tunnelLimits.windowBytes
        )
          throw new Error("Unbacked request credit.");
        if (initialized) outstanding -= frame.bytes;
        initialized = true;
        available += frame.bytes;
        wakeSend?.();
      } else if (frame.type === "data") {
        if (!responded) throw new Error("Response data precedes headers.");
        receive(frame);
      } else if (frame.type === "end") {
        if (!responded) throw new Error("Response ended before headers.");
        ended = true;
        wake?.();
        wakeSend?.();
        cleanup();
        socket.close();
      } else {
        notStarted = frame.type === "error" && frame.outcome === "not-started";
        fail();
      }
    } catch {
      fail();
    }
  });
  const receive = (frame: TunnelData) => {
    const bytes = decodeTunnelBytes(frame.bytes);
    if (
      bytes.length > outputCredit ||
      queued + Math.max(1, bytes.length) > tunnelLimits.windowBytes ||
      (open.operation.transport === "http" && (frame.text || frame.more || bytes.length === 0))
    )
      throw new Error("Response credit exceeded.");
    outputCredit -= bytes.length;
    queued += Math.max(1, bytes.length);
    queue.push({ bytes, text: frame.text, more: frame.more === true });
    wake?.();
  };
  signal.addEventListener("abort", fail, { once: true });
  if (signal.aborted) fail();
  return {
    response: response.promise,
    send: async (bytes, text = false, message = false) => {
      await ready.promise;
      if (inputEnded || (message && bytes.length > tunnelLimits.windowBytes))
        throw new Error("Request message exceeds its limit.");
      sent += bytes.length;
      if (sent > (message ? tunnelLimits.websocketRequestBytes : tunnelLimits.requestBytes))
        throw new Error("Request exceeds its limit.");
      if (message && bytes.length === 0)
        send({ v: 1, type: "data", id: 1, bytes: "", text, more: false });
      for (let offset = 0; offset < bytes.length;) {
        while (!stopped && !ended && available === 0)
          await new Promise<void>((resolve) => {
            wakeSend = resolve;
          });
        wakeSend = undefined;
        if (ended || stopped) throw failure ?? new Error("The remote operation ended.");
        const size = Math.min(available, tunnelLimits.chunkBytes, bytes.length - offset);
        available -= size;
        outstanding += size;
        send({
          v: 1,
          type: "data",
          id: 1,
          bytes: encodeTunnelBytes(bytes.subarray(offset, offset + size)),
          text,
          ...(message ? { more: offset + size < bytes.length } : {}),
        });
        offset += size;
      }
    },
    end: async () => {
      await ready.promise;
      if (!ended && !stopped && !inputEnded) {
        inputEnded = true;
        send({ v: 1, type: "end", id: 1 });
      }
    },
    next: async () => {
      while (!queue.length && !ended && !stopped)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      wake = undefined;
      if (failure) throw failure;
      const part = queue.shift();
      if (part) {
        queued -= Math.max(1, part.bytes.length);
        acknowledged += part.bytes.length;
      }
      return part;
    },
    consumed: (bytes) => {
      if (bytes <= 0 || bytes > acknowledged) throw new Error("Unbacked response acknowledgement.");
      acknowledged -= bytes;
      outputCredit += bytes;
      if (!ended && !stopped) send({ v: 1, type: "credit", id: 1, bytes });
    },
    close: () => {
      if (!ended && !stopped && started) {
        try {
          send({ v: 1, type: "cancel", id: 1 });
        } catch {}
      }
      fail();
      cleanup();
      socket.close();
    },
  };
}
