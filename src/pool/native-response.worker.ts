import type { NativeStreamLease } from "./native-streams.ts";

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
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const value = await reader.read();
          if (value.done) {
            lease.release();
            controller.close();
          } else controller.enqueue(value.value);
        } catch (error) {
          lease.release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        lease.release();
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
