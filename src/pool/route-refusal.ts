import { resumeLayerPort } from "./stream-splice.ts";

/** Every routed credential's proxy points here; a node error naming it is a refused route. */
export const routePeerAddress = "127.0.0.1:20990";
// The node's refusal bodies are small; anything larger is passed through unscanned.
const scannedBytes = 64 * 1024;
const message = "Signalbox did not send this request: its outgoing route is down.";

function anthropic(request: Request) {
  return /\/(?:v1\/)?messages$/.test(new URL(request.url).pathname);
}

/** Home's status text for a credential whose route refused it names the proxy; show the code. */
export function routeSafeMessage(message: string | null) {
  return message?.includes(routePeerAddress) ? "route_down" : message;
}

/** The model error a caller sees in place of the node's raw refusal. */
export function routeDownRefusal(request: Request) {
  return Response.json(
    anthropic(request)
      ? { type: "error", error: { type: "api_error", message } }
      : { error: { type: "server_error", code: "route_down", message } },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "X-Signalbox-Route-Refused": "route_down" },
    },
  );
}

/**
 * A container answer as a caller may see it: model calls reach the node directly (8317) or through
 * the resume layer in front of it, and either carries the node's refusal text.
 */
export function routeSafeAnswer(request: Request, port: number, answer: Response) {
  return port === 8317 || port === resumeLayerPort ? routeDownAnswer(request, answer) : answer;
}

/**
 * The node's text for a refused route names the provider URL and the loopback proxy. It is
 * replaced before it reaches any client, log or trace; only the reason code survives.
 */
export async function routeDownAnswer(request: Request, response: Response) {
  if (response.ok || response.status === 101 || !response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < scannedBytes) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    size += next.value.byteLength;
  }
  const prefix = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (new TextDecoder().decode(prefix).includes(routePeerAddress)) {
    if (!done) void reader.cancel().catch(() => {});
    return routeDownRefusal(request);
  }
  const body = done
    ? prefix
    : new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(prefix);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
