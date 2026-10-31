import type { NativeStreamLease } from "./native-streams.ts";

/** This private socket carries only lifetime: closing it releases the registry lease. */
export function nativeSession(lease: NativeStreamLease): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  const close = () => {
    lease.release();
    try {
      server.close(1000, "Session ended");
    } catch {}
  };
  server.addEventListener("close", close);
  server.addEventListener("error", close);
  server.addEventListener("message", close);
  lease.onClose(close);
  lease.signal.addEventListener("abort", close, { once: true });
  return new Response(null, { status: 101, webSocket: pair[0] });
}

/** Cloudflare's upgraded sockets need a relay so persisted revocation can close both ends. */
export function nativeResponse(response: Response, lease: NativeStreamLease): Response {
  if (response.status === 101 && response.webSocket) {
    const upstream = response.webSocket;
    const pair = new WebSocketPair();
    const client = pair[0],
      server = pair[1];
    upstream.accept();
    server.accept();
    const close = () => {
      try {
        upstream.close(1000, "Connection ended");
      } catch {}
      try {
        server.close(1000, "Connection ended");
      } catch {}
      lease.release();
    };
    lease.onClose(close);
    upstream.addEventListener("message", (event) => {
      try {
        server.send(event.data);
      } catch {
        close();
      }
    });
    server.addEventListener("message", (event) => {
      try {
        upstream.send(event.data);
      } catch {
        close();
      }
    });
    for (const socket of [upstream, server]) {
      socket.addEventListener("close", close);
      socket.addEventListener("error", close);
    }
    lease.signal.addEventListener("abort", close, { once: true });
    if (lease.signal.aborted) close();
    return new Response(null, { status: 101, headers: response.headers, webSocket: client });
  }
  if (!response.body) {
    lease.release();
    return response;
  }
  const reader = response.body.getReader();
  let ended = false;
  let detach = () => {};
  const finish = () => { ended = true; detach(); lease.release(); };
  return new Response(
    new ReadableStream({
      start(controller) {
        const close = () => {
          if (ended) return;
          finish();
          void reader.cancel().catch(() => {});
          controller.error(new Error("Connection ended"));
        };
        lease.signal.addEventListener("abort", close, { once: true });
        detach = () => lease.signal.removeEventListener("abort", close);
        lease.onClose(close);
        if (lease.signal.aborted) close();
      },
      async pull(controller) {
        try {
          const value = await reader.read();
          if (ended) return;
          if (value.done) {
            finish();
            controller.close();
          } else controller.enqueue(value.value);
        } catch (error) {
          if (ended) return;
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish();
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
