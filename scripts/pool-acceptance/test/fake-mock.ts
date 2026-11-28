// The emulated upstream's send record, faked behind the load tests' pools: each pool request is
// recorded as the mock would have recorded its answer, on the test's clock, and read back through
// the real keyed route and the driver's real witness.
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { frameTimer } from "../../emulated-upstream/frames.ts";
import { gate } from "../../emulated-upstream/gateway.ts";
import {
  durableSends,
  markerIn,
  recorded,
  sendsControl,
  type MockSend,
} from "../../emulated-upstream/sends.ts";
import { memorySendStorage } from "../../emulated-upstream/test/memory-sends.ts";
import { paths } from "../load-verdict.mjs";
import { mockWitness } from "../load-witness.ts";

export const witnessKey = "w".repeat(43);

/**
 * What the mock keeps of one send: by default the record it made. A test returns another, none or
 * more, for a mock whose record disagrees with what the driver saw.
 */
export type Says = (send: MockSend) => readonly MockSend[];

const shapeOf = Object.fromEntries(
  Object.entries(paths).map(([shape, path]) => [path, shape]),
) as Record<string, keyof typeof paths>;

export function fakeMock(wall: () => number = () => Date.now()) {
  const storage = memorySendStorage();
  const store = durableSends(storage, wall);
  const keep = (run: string, send: MockSend, says?: Says) => {
    for (const kept of says ? says(send) : [send]) void store.save(run, kept);
  };
  const control = (request: Request) =>
    gate(request, witnessKey, (keyed) => sendsControl(keyed, store));
  return {
    rows: storage.rows,
    control,
    /** The keyed read route, served for a Node request. */
    async serve(request: IncomingMessage, response: ServerResponse, origin: string) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === "string") headers.set(name, value);
      const answer = await control(new Request(`${origin}${request.url}`, { headers }));
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(await answer.text());
    },
    /** A pool request answered through a Node response: recorded as it is written. */
    watch(body: string, path: string, response: ServerResponse, says?: Says) {
      const marked = markerIn(body);
      if (!marked) return;
      const receivedAt = wall();
      let headersAt: number | undefined;
      let timer: ReturnType<typeof frameTimer> | undefined;
      let saved = false;
      const decoder = new TextDecoder();
      const observe = (chunk: unknown) => {
        if (typeof chunk === "string") timer?.observe(chunk, wall());
        else if (chunk instanceof Uint8Array) timer?.observe(decoder.decode(chunk), wall());
      };
      const finish = (end: MockSend["end"]) => {
        if (saved) return;
        saved = true;
        const endedAt = wall();
        timer?.end(endedAt);
        keep(
          marked.run,
          {
            marker: marked.marker,
            path,
            status: response.statusCode,
            receivedAt,
            headersAt: headersAt ?? endedAt,
            firstContentAt: timer ? timer.firstContentMs : end === "complete" ? endedAt : undefined,
            stallMs: timer?.stallMs,
            endedAt,
            end,
          },
          says,
        );
      };
      const writeHead = response.writeHead.bind(response) as (
        status: number,
        headers?: OutgoingHttpHeaders,
      ) => ServerResponse;
      response.writeHead = ((status: number, headers?: OutgoingHttpHeaders) => {
        headersAt = wall();
        const type = String(headers?.["content-type"] ?? "");
        if (status === 200 && type.includes("text/event-stream") && shapeOf[path])
          timer = frameTimer(shapeOf[path]);
        return writeHead(status, headers);
      }) as typeof response.writeHead;
      const write = response.write.bind(response) as (...args: unknown[]) => boolean;
      response.write = ((chunk: unknown, ...rest: unknown[]) => {
        observe(chunk);
        return write(chunk, ...rest);
      }) as typeof response.write;
      const end = response.end.bind(response) as (...args: unknown[]) => ServerResponse;
      response.end = ((chunk?: unknown, ...rest: unknown[]) => {
        observe(chunk);
        finish("complete");
        return end(chunk, ...rest);
      }) as typeof response.end;
      response.once("close", () => finish("cut"));
    },
    /** An in-memory pool's answer, through the mock's own record. */
    answer(body: string, path: string, receivedAt: number, answer: Response, says?: Says) {
      const marked = markerIn(body);
      if (!marked) return answer;
      return recorded(answer, {
        marker: marked.marker,
        path,
        receivedAt,
        now: wall,
        save: (send) => keep(marked.run, send, says),
      });
    },
    /** The driver's witness, reading this mock through its keyed route in memory. */
    witness: () =>
      mockWitness({
        origin: "https://mock.invalid",
        key: witnessKey,
        fetch: async (input, init) => control(new Request(input, init)),
      }),
  };
}
