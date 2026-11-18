import { randomUUID } from "node:crypto";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import type { Conversation } from "../pool-acceptance/types.ts";
import type { Traffic } from "./rehearsal-plan.ts";
import type { RehearsalPoolAccess } from "./rehearsal-seed.ts";

const trafficIntervalMs = 5_000;
type TurnClient = {
  sendTurn(key: string, model: string, conversation: Conversation): Promise<unknown>;
};

/**
 * Short streamed model turns through the clean pool for the length of a release. A turn runs on the
 * serving runtime and holds its lease while in flight, so capacity and drain waits see real load.
 */
export function modelTraffic(
  access: RehearsalPoolAccess,
  model: string,
  signal: AbortSignal,
  client: TurnClient = new PoolAcceptanceClient({ origin: access.modelUrl }),
  intervalMs = trafficIntervalMs,
): Traffic {
  const counts = { ok: 0, failed: 0 };
  let stopped = false;
  let wake: () => void = () => {};
  const loop = (async () => {
    while (!stopped && !signal.aborted) {
      try {
        await client.sendTurn(access.modelKey, model, { id: randomUUID(), expectedRecords: 1 });
        counts.ok += 1;
      } catch {
        counts.failed += 1;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, intervalMs).unref?.();
      });
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      wake();
      await loop;
      return { ...counts };
    },
  };
}

type Socket = {
  readyState: number;
  close(): void;
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
};
type SocketFactory = (url: string, headers: Record<string, string>) => Socket;

/** Node's WebSocket accepts headers, which the pool's bearer-authenticated upgrade needs. */
const nodeSocket: SocketFactory = (url, headers) =>
  new (WebSocket as unknown as new (
    url: string,
    init: { headers: Record<string, string> },
  ) => Socket)(url, {
    headers,
  });

/**
 * One idle Responses WebSocket on the serving runtime. The Worker renews its upgrade assertion, so
 * it stays open until closed and keeps the old generation's drain from finishing.
 */
export async function holdModelSocket(
  access: RehearsalPoolAccess,
  open: SocketFactory = nodeSocket,
  timeoutMs = 30_000,
): Promise<{ close(): Promise<void> }> {
  const url = new URL("/v1/responses", access.modelUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = open(url.href, { Authorization: `Bearer ${access.modelKey}` });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The held model socket did not open")),
      timeoutMs,
    );
    socket.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
    socket.addEventListener(
      "error",
      () => (clearTimeout(timer), reject(new Error("The held model socket failed to open"))),
      { once: true },
    );
  });
  let closedEarly = false;
  socket.addEventListener("close", () => void (closedEarly = true), { once: true });
  return {
    close: async () => {
      // A socket the pool closed before the drain deadline would make the timeout scenario meaningless.
      if (closedEarly)
        throw new Error("The held model socket closed before the rehearsal released it");
      await new Promise<void>((resolve) => {
        socket.addEventListener("close", () => resolve(), { once: true });
        socket.close();
        setTimeout(resolve, 5_000).unref?.();
      });
    },
  };
}
