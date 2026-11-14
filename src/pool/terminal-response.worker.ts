import {
  TerminalProtocol,
  type TerminalOutcome,
  type TerminalCompletion,
} from "./terminal-protocol.ts";

export type TerminalFinish = (outcome: TerminalOutcome, status: number, bytes: number) => void;

/** Read only as the client pulls. A slow client never creates a second buffered body. */
export function terminalResponse(
  response: Response,
  finish: TerminalFinish,
  signal: AbortSignal,
  pathname: string,
  completion: TerminalCompletion,
): Response {
  if (!response.body) {
    finish(response.ok ? "truncated" : "provider_failed", response.status, 0);
    return response;
  }
  const reader = response.body.getReader();
  const contentType = response.headers.get("Content-Type") ?? "";
  const rawBody =
    ["/v1/audio/speech", "/v1/tts"].includes(pathname) &&
    !/^(?:application|text)\/(?:[a-z0-9.-]+\+)?json(?:;|$)/i.test(contentType);
  const protocol = new TerminalProtocol(
    /^text\/event-stream(?:;|$)/i.test(contentType) ? "sse" : rawBody ? "body" : "json",
    response.status,
    pathname,
    completion,
  );
  let ended = false;
  let recorded = false;
  const report = (outcome: TerminalOutcome, bytes: number) => {
    if (recorded) return;
    recorded = true;
    finish(outcome, response.status, bytes);
  };
  let detach = () => {};
  const lengthHeader = response.headers.has("Content-Encoding")
    ? null
    : response.headers.get("Content-Length");
  const expectedBytes =
    lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
  const end = (outcome?: TerminalOutcome) => {
    if (ended) return;
    ended = true;
    detach();
    const result = protocol.finish();
    report(
      outcome ??
        (expectedBytes !== undefined && expectedBytes !== result.bytes
          ? "truncated"
          : result.outcome),
      result.bytes,
    );
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          if (ended) return;
          end("client_closed");
          void reader.cancel().catch(() => {});
          controller.error(new Error("Connection ended"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        detach = () => signal?.removeEventListener("abort", abort);
        if (signal?.aborted) abort();
      },
      async pull(controller) {
        try {
          const value = await reader.read();
          if (ended) return;
          if (value.done) {
            end();
            controller.close();
          } else {
            protocol.push(value.value);
            controller.enqueue(value.value);
            // SDKs cancel the reader after their protocol terminal instead of waiting for EOF.
            const observed = protocol.observed();
            if (observed) report(observed, protocol.count());
          }
        } catch (error) {
          if (ended) return;
          end("truncated");
          controller.error(error);
        }
      },
      async cancel(reason) {
        end("client_closed");
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  );
}
