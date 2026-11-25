import { streamTerminalTypes } from "./stream-splice.ts";
import { failurePlacementHeaders } from "./runtime-placement.worker.ts";
import { runtimeFailureHeaders } from "./runtime-route-diagnostic.ts";
import { retainEndpointRequestId } from "./runtime-fleet/endpoint-trace.ts";

const message = "The model runtime restarted. Please retry this request.";
// Claude Code gives up after three overload answers; an api_error keeps its full retry budget.
const claudeError = { type: "error", error: { type: "api_error", message } };
// Past this much of one unfinished event the stream is passed through instead of parsed. A large
// final event fits; an event that never ends cannot hold the isolate's memory.
const parsedCharacters = 4 * 1024 * 1024;
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
        ...failurePlacementHeaders(error),
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
  // The answer's own bytes pass on unchanged: the router resumes from the bytes delivered, so a
  // re-encoded invalid byte or a dropped BOM would move its offset. Text is decoded only to watch.
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }),
    encoder = new TextEncoder();
  let pending: Uint8Array = new Uint8Array(),
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
          streamTerminalTypes.has(String(event.type))
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
              if (next.done) {
                ended = true;
                controller.close();
                return;
              }
              if (next.value.byteLength) return controller.enqueue(next.value);
              continue;
            }
            if (next.done) {
              if (!terminal) throw new Error("Native stream ended before completion");
              ended = true;
              if (pending.byteLength) controller.enqueue(pending);
              controller.close();
              return;
            }
            const scanned = pending.byteLength;
            const joined = new Uint8Array(scanned + next.value.byteLength);
            joined.set(pending);
            joined.set(next.value, scanned);
            pending = joined;
            // Earlier bytes hold no boundary, so only a separator reaching back into them is new.
            const end = lastBoundary(pending, Math.max(0, scanned - 3));
            if (end) {
              const frames = pending.slice(0, end);
              observe(decoder.decode(frames));
              controller.enqueue(frames);
              pending = pending.slice(end);
            }
            if (pending.byteLength > parsedCharacters) {
              // Holding and rescanning one endless event would grow memory and time with its square.
              controller.enqueue(pending);
              pending = new Uint8Array();
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
            if (!request.signal.aborted) interrupted?.(error);
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

/**
 * Where the last complete event ends in these bytes: after a blank line, `\n` or `\r\n` twice.
 * Line endings are ASCII, so they are found in the bytes themselves, whatever the text holds.
 */
function lastBoundary(bytes: Uint8Array, from: number) {
  let end = 0;
  for (let index = from; index < bytes.length; index++) {
    if (bytes[index] !== 0x0a) continue;
    if (bytes[index + 1] === 0x0a) end = index + 2;
    else if (bytes[index + 1] === 0x0d && bytes[index + 2] === 0x0a) end = index + 3;
  }
  return end;
}
