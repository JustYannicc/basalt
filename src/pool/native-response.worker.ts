import { bindModelLifetime } from "./model-lifetime.worker.ts";
import type { NativeStreamLease } from "./native-streams.ts";
import { connectionEnded, reportStreamBroken } from "./stream-broken.ts";

export function nativeControlPair(headers: Headers) {
  const pair = new WebSocketPair();
  return {
    server: pair[1],
    response: new Response(null, { status: 101, headers, webSocket: pair[0] }),
  };
}

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

/** Data stays natively coupled; the private completion channel owns revocation and release. */
export function nativeResponse(response: Response, lease: NativeStreamLease): Response {
  if (response.status === 101 && response.webSocket) {
    if (bindModelLifetime(response, lease)) return response;
    lease.release();
    try {
      response.webSocket.accept();
    } catch {}
    try {
      response.webSocket.close(1000, "Lifetime unavailable");
    } catch {}
    throw new Error("Model socket lifetime is unavailable");
  }
  if (!response.body) {
    lease.release();
    return response;
  }
  const reader = response.body.getReader();
  let ended = false,
    failing = false;
  let detach = () => {};
  const finish = () => {
    ended = true;
    detach();
    lease.release();
  };
  return new Response(
    new ReadableStream({
      start(controller) {
        const close = () => {
          if (ended || failing) return;
          finish();
          void reader.cancel().catch(() => {});
          controller.error(connectionEnded());
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
          reportStreamBroken("native", error);
          failing = true;
          try {
            await lease.failed?.(error);
          } catch {
            ended = true;
            detach();
            controller.error(error);
            return;
          }
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        if (!failing) finish();
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
