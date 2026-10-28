/**
 * Profile one Worker cold start the way `wrangler check startup` does, with the Miniflare this
 * package pins: https://developers.cloudflare.com/workers/wrangler/commands/workers/#check-startup
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

/** A V8 CPU profile, as the DevTools protocol's `Profiler.stop` returns it. */
export interface CpuProfile {
  readonly nodes: ReadonlyArray<{
    readonly id: number;
    readonly callFrame: { readonly functionName: string };
    readonly children?: ReadonlyArray<number>;
  }>;
  readonly samples: ReadonlyArray<number>;
  readonly timeDeltas: ReadonlyArray<number>;
  /** Microseconds. */
  readonly startTime: number;
  readonly endTime: number;
}

/**
 * Fixed work the profiled request runs right before and right after importing the main module.
 * A sample in each proves V8's sampler ran across the whole start, so a start with no samples of
 * its own is cheap, not unmeasured. Their CPU is not the Worker's and is left out.
 */
export const witnesses = ["startupWitnessBefore", "startupWitnessAfter"] as const;
/** Sample every 100 µs rather than V8's default of about 1 ms: cheap starts and witnesses register. */
const samplingIntervalUs = 100;

/** One start as the profile saw it: its CPU, and whether the sampler demonstrably covered it. */
export interface Reading {
  /** Non-idle sampled CPU outside the witnesses, garbage collection included, as Wrangler reports it. */
  readonly activeMs: number;
  /** Both witnesses were sampled; otherwise the start says nothing about the Worker's cost. */
  readonly conclusive: boolean;
}

export const read = (profile: CpuProfile): Reading => {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  // Each node's witness, if it runs inside one.
  const witnessOf = new Map<number, string>();
  const mark = (id: number, witness: string) => {
    witnessOf.set(id, witness);
    for (const child of byId.get(id)?.children ?? []) mark(child, witness);
  };
  for (const node of profile.nodes)
    if ((witnesses as ReadonlyArray<string>).includes(node.callFrame.functionName)) mark(node.id, node.callFrame.functionName);
  const witnessed = new Set<string>();
  let micros = 0;
  // Each sample covers the time since the previous one. The first witness sample after other work
  // covers mostly that work, so it counts as the Worker's, as it would after a late sample.
  const busy = (id: number | undefined) =>
    id !== undefined && !witnessOf.has(id) && byId.get(id)?.callFrame.functionName !== "(idle)";
  profile.samples.forEach((id, index) => {
    const witness = witnessOf.get(id);
    if (witness) witnessed.add(witness);
    if (witness ? busy(profile.samples[index - 1]) : busy(id)) micros += profile.timeDeltas[index] ?? 0;
  });
  return { activeMs: micros / 1_000, conclusive: witnesses.every((witness) => witnessed.has(witness)) };
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
const inspect = (socket: WebSocket, id: number, method: string, params?: object) =>
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
    socket.send(JSON.stringify({ id, method, params }));
  });

/** workerd's type for each uploaded module; Rolldown emits only these. */
const moduleType = (path: string) => {
  if (path.endsWith(".js")) return "ESModule";
  if (path.endsWith(".wasm")) return "CompiledWasm";
  throw new Error(`Unsupported module type: ${path}`);
};

// Fixed work in named functions; each is called once from a cold caller, so V8 never inlines it.
const witness = (name: string) =>
  `function ${name}() { let x = 0; for (let i = 0; i < 1_000_000; i++) x = (x + i * 7) % 1_000_003; return x; }`;

/**
 * Start a fresh workerd isolate that imports `main` inside a request while V8's profiler runs.
 * Modules are keyed by absolute path. Unlike Wrangler, a module that throws while evaluating
 * fails here instead of yielding a truncated, too-cheap profile.
 *
 * Only the profiled request, at a path no one else knows, imports `main`. Miniflare's readiness
 * probe sometimes reaches the Worker first; when any request imported it, about one start in 20
 * evaluated the Worker before the profiler started and read as free.
 */
export const profileStartup = async (
  name: string,
  main: string,
  modules: ReadonlyMap<string, Buffer>,
  compatibility: { readonly date: string; readonly flags: ReadonlyArray<string> },
): Promise<CpuProfile> => {
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const path = `/${randomUUID()}`;
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
          contents: `${witnesses.map(witness).join("\n")}
          let started = false;
          export default { async fetch(request) {
            if (new URL(request.url).pathname !== ${JSON.stringify(path)}) return new Response(null, { status: 404 });
            if (started) return new Response("The Worker already started", { status: 409 });
            started = true;
            globalThis.witnessed = ${witnesses[0]}();
            try { await import(${JSON.stringify(main)}); }
            catch (error) { return new Response(String(error?.stack ?? error), { status: 500 }); }
            globalThis.witnessed += ${witnesses[1]}();
            return new Response("ok");
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
      await inspect(socket, 2, "Profiler.setSamplingInterval", { interval: samplingIntervalUs });
      await inspect(socket, 3, "Profiler.start");
      const response = await mf.dispatchFetch(new URL(path, origin));
      const body = await response.text();
      if (!response.ok) throw new Error(`${name} failed to start:\n${body}`);
      return (await inspect(socket, 4, "Profiler.stop")).profile;
    } finally {
      socket.close();
    }
  } finally {
    await mf.dispose();
  }
};
