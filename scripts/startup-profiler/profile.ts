/**
 * Profile one Worker cold start the way `wrangler check startup` does, with the Miniflare this
 * package pins: https://developers.cloudflare.com/workers/wrangler/commands/workers/#check-startup
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

/** A V8 CPU profile, as the DevTools protocol's `Profiler.stop` returns it. */
export interface CpuProfile {
  readonly nodes: ReadonlyArray<{ readonly id: number; readonly callFrame: { readonly functionName: string } }>;
  readonly samples: ReadonlyArray<number>;
  readonly timeDeltas: ReadonlyArray<number>;
  /** Microseconds. */
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * Whether V8's sampler kept up. On a loaded machine it can stall for a whole start, leaving one
 * idle sample and a falsely cheap profile. A working sampler takes one about every 1.5 ms; fewer
 * than one per 10 ms of the profile means it stalled.
 */
export const sampled = (profile: CpuProfile) =>
  profile.samples.length >= (profile.endTime - profile.startTime) / 10_000;

/** Non-idle sampled CPU in a V8 CPU profile, including garbage collection, as Wrangler reports it. */
export const activeMs = (profile: CpuProfile) => {
  const idle = new Set(profile.nodes.filter((node) => node.callFrame.functionName === "(idle)").map((node) => node.id));
  let micros = 0;
  profile.samples.forEach((id, index) => {
    if (!idle.has(id)) micros += profile.timeDeltas[index] ?? 0;
  });
  return micros / 1_000;
};

let miniflare: any;
export const loadMiniflare = () => {
  try {
    return (miniflare ??= createRequire(import.meta.url)("miniflare"));
  } catch (cause) {
    throw new Error("Install the profiler first: bun install --cwd scripts/startup-profiler --frozen-lockfile", { cause });
  }
};

/** Send one Chrome DevTools Protocol command and wait for its result, or for the socket to fail. */
const inspect = (socket: WebSocket, id: number, method: string) =>
  new Promise<any>((resolve, reject) => {
    const settle = (finish: () => void) => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onClose);
      finish();
    };
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      settle(() => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result)));
    };
    const onClose = () => settle(() => reject(new Error(`The inspector closed during ${method}`)));
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
    socket.send(JSON.stringify({ id, method }));
  });

/** workerd's type for each uploaded module; Rolldown emits only these. */
const moduleType = (path: string) => {
  if (path.endsWith(".js")) return "ESModule";
  if (path.endsWith(".wasm")) return "CompiledWasm";
  throw new Error(`Unsupported module type: ${path}`);
};

/**
 * Start a fresh workerd isolate that imports `main` inside a request while V8's profiler runs.
 * Modules are keyed by absolute path. Unlike Wrangler, a module that throws while evaluating
 * fails here instead of yielding a truncated, too-cheap profile.
 */
export const profileStartup = async (
  name: string,
  main: string,
  modules: ReadonlyMap<string, Buffer>,
  compatibility: { readonly date: string; readonly flags: ReadonlyArray<string> },
): Promise<CpuProfile> => {
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "profiler",
      compatibilityDate: compatibility.date,
      compatibilityFlags: [...compatibility.flags],
      modulesRoot: "/",
      modules: [
        {
          type: "ESModule",
          path: `/${randomUUID()}.js`,
          contents: `export default { async fetch() {
            try { await import(${JSON.stringify(main)}); return new Response("ok"); }
            catch (error) { return new Response(String(error?.stack ?? error), { status: 500 }); }
          } };`,
        },
        ...[...modules].map(([path, contents]) => ({ type: moduleType(path), path, contents })),
      ],
      inspectorPort: 0,
      handleStructuredLogs: () => undefined,
    }),
  );
  try {
    const origin = await mf.ready;
    const socket = new WebSocket(new URL("/core:user:profiler", await mf.getInspectorURL()));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    try {
      await inspect(socket, 1, "Profiler.enable");
      await inspect(socket, 2, "Profiler.start");
      const response = await mf.dispatchFetch(origin);
      const body = await response.text();
      if (!response.ok) throw new Error(`${name} failed to start:\n${body}`);
      return (await inspect(socket, 3, "Profiler.stop")).profile;
    } finally {
      socket.close();
    }
  } finally {
    await mf.dispose();
  }
};
