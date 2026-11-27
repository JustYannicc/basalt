import { shortPrompt } from "./prompts.ts";

/** The part of a Durable Object's container the mock's start uses; tests fake it. */
export interface MockPort {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
export interface MockContainer {
  readonly running: boolean;
  start(options: { enableInternet: boolean; env: Record<string, string> }): void;
  monitor(): Promise<unknown>;
  getTcpPort(port: number): MockPort;
}

export const port = 4010;
/** A keyed caller asks the Worker to have the mock itself refuse a call without and with a wrong key. */
export const refusalPath = "/_emulated/mock-refusal";

/**
 * Starts the mock once and lets a request through only after its health route answered: concurrent
 * first requests share one start, and readiness drops when the container stops, so the next request
 * starts it again instead of reaching a port nothing listens on.
 */
export function mockStarter(
  container: MockContainer,
  env: Record<string, string>,
  wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  attempts = 120,
) {
  let ready = false;
  let starting: Promise<void> | undefined;
  const start = async () => {
    const run = { stopped: false };
    if (!container.running) container.start({ enableInternet: false, env });
    const stopped = () => {
      run.stopped = true;
      ready = false;
    };
    container.monitor().then(stopped, stopped);
    for (let attempt = 0; attempt < attempts && !run.stopped; attempt++) {
      try {
        // aimock listens a moment after its process starts; its health route needs no key.
        const answer = await container
          .getTcpPort(port)
          .fetch("http://mock/health", { signal: AbortSignal.timeout(2000) });
        await answer.body?.cancel();
        if (answer.ok && !run.stopped) {
          ready = true;
          return;
        }
      } catch {}
      await wait(500);
    }
    throw new Error(run.stopped ? "The mock stopped while starting" : "The mock did not start");
  };
  return {
    async ready() {
      // A start in progress is awaited first: `running` turns true before the port listens.
      if (starting) return starting;
      if (ready && container.running) return;
      starting = start().finally(() => (starting = undefined));
      return starting;
    },
  };
}

/** What the mock itself answers without the key and with a wrong one; both must be its own 401. */
export async function mockRefusal(mock: MockPort, key: string) {
  const call = async (headers: Record<string, string>) => {
    const answer = await mock.fetch("http://mock/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        model: "emulated-check",
        messages: [{ role: "user", content: shortPrompt }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    await answer.body?.cancel();
    // aimock's own refusal names its realm; a refusal from anything in front of it would not.
    const realm = /realm="aimock"/u.test(answer.headers.get("www-authenticate") ?? "");
    return { status: answer.status, aimock: realm };
  };
  return { missing: await call({}), wrong: await call({ authorization: `Bearer ${key}-wrong` }) };
}
