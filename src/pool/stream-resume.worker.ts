import { nativeResponse } from "./native-response.worker.ts";
import type { NativeStreamLease } from "./native-streams.ts";
import type { TerminalOutcome } from "./terminal-protocol.ts";

/**
 * The controller's side of a resumed answer: it holds a stream lease for the resumed part, as for
 * any model stream, and records the call's outcome once, counting the bytes delivered before the
 * cut. The bytes pass through unchanged, so the entry's offset stays the container's.
 */
export function resumedAnswer(
  answer: Response,
  deps: {
    from: number;
    lease: NativeStreamLease;
    finish?: (outcome: TerminalOutcome, status: number, bytes: number) => void;
  },
) {
  if (!answer.body) {
    deps.lease.release();
    return answer;
  }
  const finish = deps.finish ?? (() => {});
  const reader = answer.body.getReader();
  let bytes = deps.from;
  const counted = new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            finish("complete", answer.status, bytes);
            return controller.close();
          }
          bytes += part.value.byteLength;
          controller.enqueue(part.value);
        } catch (error) {
          finish("truncated", answer.status, bytes);
          controller.error(error);
        }
      },
      async cancel(reason) {
        finish("client_closed", answer.status, bytes);
        await reader.cancel(reason);
      },
    }),
    { status: answer.status, statusText: answer.statusText, headers: answer.headers },
  );
  return nativeResponse(counted, deps.lease);
}
