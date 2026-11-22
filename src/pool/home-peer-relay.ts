export const homePeerWindow = 64 * 1024;
export const homePeerChunk = 16 * 1024;

export interface HomePeerSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export interface HomePeerWebSocket {
  binaryType: "blob" | "arraybuffer";
  send(value: string | ArrayBuffer | ArrayBufferView): void;
  close(code: number, reason: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
}

/** Credits follow completed TCP writes, so a slow Home cannot grow either socket's send queue. */
export function relayHomePeer(
  socket: HomePeerSocket,
  peer: HomePeerWebSocket,
  keepAlive: (work: Promise<void>) => void,
) {
  peer.binaryType = "arraybuffer";
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let stopped = false;
  let incomingFinished = false;
  let outgoingFinished = false;
  let writtenFinished = false;
  let credit = 0;
  let received = 0;
  const incoming = new Uint8Array(homePeerWindow);
  let pending = 0;
  let readOffset = 0;
  let writeOffset = 0;
  let wakeWriter: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });

  function stop(code = 1000) {
    if (stopped) return;
    stopped = true;
    wake?.();
    wakeWriter?.();
    try {
      peer.close(code, code === 1000 ? "Peer ended" : "Peer refused");
    } catch {}
    void reader.cancel().catch(() => {});
    void writer.abort().catch(() => {});
    void socket.close().catch(() => {});
    finish();
  }

  function send(value: string | Uint8Array) {
    if (stopped) return;
    try {
      peer.send(value);
    } catch {
      stop(1011);
    }
  }

  function drained() {
    if (outgoingFinished && writtenFinished) stop();
  }

  function control(value: string) {
    if (value.length > 64) return stop(1002);
    let message: unknown;
    try {
      message = JSON.parse(value);
    } catch {
      return stop(1002);
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return stop(1002);
    const keys = Object.keys(message);
    if (keys.length !== 1) return stop(1002);
    if ("credit" in message) {
      const amount = message.credit;
      if (
        !Number.isSafeInteger(amount) ||
        typeof amount !== "number" ||
        amount < 1 ||
        amount > homePeerWindow - credit
      )
        return stop(1002);
      credit += amount;
      wake?.();
    } else if ("fin" in message && message.fin === true && !incomingFinished) {
      incomingFinished = true;
      wakeWriter?.();
    } else stop(1002);
  }

  peer.addEventListener("message", (event) => {
    if (stopped) return;
    if (typeof event.data === "string") return control(event.data);
    if (!(event.data instanceof ArrayBuffer) || incomingFinished) return stop(1002);
    const data = new Uint8Array(event.data);
    if (
      !data.byteLength ||
      data.byteLength > homePeerChunk ||
      data.byteLength > homePeerWindow - received
    )
      return stop(1002);
    received += data.byteLength;
    const first = Math.min(data.byteLength, homePeerWindow - writeOffset);
    incoming.set(data.subarray(0, first), writeOffset);
    incoming.set(data.subarray(first), 0);
    writeOffset = (writeOffset + data.byteLength) % homePeerWindow;
    pending += data.byteLength;
    wakeWriter?.();
  });
  peer.addEventListener("close", () => stop(outgoingFinished && writtenFinished ? 1000 : 1011));
  peer.addEventListener("error", () => stop(1011));
  send(JSON.stringify({ credit: homePeerWindow }));

  const writePump = (async () => {
    try {
      while (!stopped) {
        while (!pending && !incomingFinished && !stopped)
          await new Promise<void>((resolve) => {
            wakeWriter = resolve;
          });
        if (stopped) return;
        if (!pending && incomingFinished) {
          await writer.close();
          writtenFinished = true;
          drained();
          return;
        }
        const size = Math.min(pending, homePeerChunk, homePeerWindow - readOffset);
        const chunk = incoming.slice(readOffset, readOffset + size);
        readOffset = (readOffset + size) % homePeerWindow;
        pending -= size;
        await writer.write(chunk);
        received -= size;
        send(JSON.stringify({ credit: size }));
      }
    } catch {
      stop(1011);
    }
  })();

  const pump = (async () => {
    try {
      for (;;) {
        while (!credit && !stopped)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        if (stopped) return;
        const next = await reader.read();
        if (stopped) return;
        if (next.done) {
          outgoingFinished = true;
          send(JSON.stringify({ fin: true }));
          drained();
          return;
        }
        // The platform must supply bounded TCP reads as well as bounded WebSocket messages.
        if (next.value.byteLength > homePeerWindow) return stop(1002);
        for (let offset = 0; offset < next.value.byteLength;) {
          while (!credit && !stopped)
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          if (stopped) return;
          const end = Math.min(next.value.byteLength, offset + credit, offset + homePeerChunk);
          const chunk = next.value.slice(offset, end);
          credit -= chunk.byteLength;
          send(chunk);
          offset = end;
        }
      }
    } catch {
      stop(1011);
    }
  })();
  keepAlive(Promise.all([done, pump, writePump]).then(() => {}));
  return { close: () => stop(1011), done };
}
