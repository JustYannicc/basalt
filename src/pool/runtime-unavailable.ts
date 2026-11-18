import { runtimeFailureHeaders } from "./runtime-route-diagnostic.ts";
import { retainEndpointRequestId } from "./runtime-fleet/endpoint-trace.ts";

const message = "The model runtime restarted. Please retry this request.";
// Claude Code gives up after three overload answers; an api_error keeps its full retry budget.
const claudeError = { type: "error", error: { type: "api_error", message } };
// No normal event is near this size; past it the stream is passed through instead of parsed.
const parsedCharacters = 1024 * 1024;
function anthropic(request: Request) {
  return /\/(?:v1\/)?messages$/.test(new URL(request.url).pathname);
}

export function nativeRuntimeUnavailable(request: Request, error?: unknown) {
  const claude = anthropic(request);
  const response = Response.json(
    claude ? claudeError : { error: { type: "server_error", code: "server_error", message } },
    {
      status: 503,
      headers: {
        "Retry-After": "1",
        "Cache-Control": "no-store",
        ...(error === undefined ? {} : runtimeFailureHeaders(error, "fleet_forward")),
      },
    },
  );
  if (error instanceof Error) retainEndpointRequestId(error, response);
  return response;
}

/** Once headers commit, only a native SSE terminal can describe the interruption. */
export function nativeRuntimeStream(
  response: Response,
  request: Request,
  interrupted?: (error: unknown) => void,
) {
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  )
    return response;
  const path = new URL(request.url).pathname;
  const claude = anthropic(request),
    responses = path.endsWith("/responses");
  if (!claude && !responses) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder(),
    encoder = new TextEncoder();
  let pending = "",
    ended = false,
    cancelled = false,
    passthrough = false,
    terminal = false;
  const observe = (frames: string) => {
    for (const frame of frames.split(/(?:\r?\n){2}/)) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      try {
        const event: unknown = JSON.parse(data);
        if (
          event &&
          typeof event === "object" &&
          "type" in event &&
          [
            "response.completed",
            "response.failed",
            "response.incomplete",
            "message_stop",
            "error",
          ].includes(String(event.type))
        )
          terminal = true;
      } catch {}
    }
  };
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (ended) return;
        try {
          while (true) {
            const next = await reader.read();
            if (cancelled) return;
            if (passthrough) {
              const text = next.done
                ? decoder.decode()
                : decoder.decode(next.value, { stream: true });
              if (text) controller.enqueue(encoder.encode(text));
              if (next.done) {
                ended = true;
                controller.close();
              }
              if (text || next.done) return;
              continue;
            }
            if (next.done) {
              if (!terminal) throw new Error("Native stream ended before completion");
              ended = true;
              if (pending) controller.enqueue(encoder.encode(pending + decoder.decode()));
              controller.close();
              return;
            }
            pending += decoder.decode(next.value, { stream: true });
            const boundary = /(?:\r?\n){2}/g;
            let end = 0;
            for (const match of pending.matchAll(boundary)) end = match.index + match[0].length;
            if (end) {
              observe(pending.slice(0, end));
              controller.enqueue(encoder.encode(pending.slice(0, end)));
              pending = pending.slice(end);
            }
            if (pending.length > parsedCharacters) {
              // Holding and rescanning one endless event would grow memory and time with its square.
              controller.enqueue(encoder.encode(pending));
              pending = "";
              passthrough = true;
              return;
            }
            if (end) return;
          }
        } catch (error) {
          ended = true;
          void reader.cancel().catch(() => {});
          // A reader that left ends the pending read early; that is not an interruption.
          if (cancelled) return;
          if (passthrough) {
            // Mid-event, a terminal would corrupt the frame; the clients retry a cut stream.
            interrupted?.(error);
            controller.error(error);
            return;
          }
          if (terminal) {
            controller.close();
            return;
          }
          if (request.signal.aborted) {
            controller.error(error);
            return;
          }
          interrupted?.(error);
          const event = claude
            ? claudeError
            : {
                type: "response.failed",
                response: {
                  id: `recovery-${crypto.randomUUID()}`,
                  status: "failed",
                  error: { code: "server_error", message, headers: { "Retry-After": "1" } },
                },
              };
          controller.enqueue(
            encoder.encode(
              `event: ${claude ? "error" : "response.failed"}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel(reason) {
        ended = true;
        cancelled = true;
        await reader.cancel(reason);
      },
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}
