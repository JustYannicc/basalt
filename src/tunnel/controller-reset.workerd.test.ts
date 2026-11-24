import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { encodeTunnelBytes, tunnelProtocol } from "../../clients/contracts/tunnel.ts";
import { poolWorkerCompatibility } from "../pool/worker-compatibility.ts";

// A device's model call rides a tunnel session whose lease the pool's controller holds in memory.
// The router is the real tunnel host with the real model forward, replay and resume. One object
// runs the pool's entry and controller code (the entry's `fetchController` and resume route, the
// controller's `forwardPoolRequest` and `governedResume`), so replacing its instance ends them
// together, as the platform replacing the pool Worker's isolate does, and cuts its streams. Its two
// lease sets are production's: the device registry's (real `Computers`, the device registered and
// revoked through its signed control path, holding the session lease and each call's device lease)
// and the pool's (real `NativeMemberships`, each call's pool lease). Registry and memberships live
// at module level, as durable storage outlives an instance. The container's front layer is an
// object that outlives the pool.
const signingKey = "ab".repeat(32);

const pool = `
import { DurableObject } from "cloudflare:workers";
import { fetchController } from "./src/pool/controller-reset.ts";
import { routerResume, routerResumePath } from "./src/pool/router-resume.ts";
import { admitModelCall, forwardPoolRequest } from "./src/pool/forward.worker.ts";
import { governedResume } from "./src/pool/resume-admission.worker.ts";
import { stampResumeTarget } from "./src/pool/stream-resume.ts";
import { nativeSession } from "./src/pool/native-response.worker.ts";
import { NativeStreams } from "./src/pool/native-streams.ts";
import { NativeMemberships } from "./src/pool/membership.ts";
import { PoolLifecycle } from "./src/pool/lifecycle.ts";
import { RuntimeProtection } from "./src/pool/runtime-protection.ts";
import { nativeControlPath, nativeControlPrefix, nativeSessionPath } from "./src/pool/native-contract.ts";
import { signEnvelope } from "./src/pool/token.ts";
import { fixture as computersFixture, owner, pool as devicePool } from "./src/pool/test/computers.ts";
import { membershipGraceFixture } from "./scripts/pool-tests/membership-grace-fixture.ts";

const keys = { key: "${signingKey}" };
const devices = computersFixture();
const grace = membershipGraceFixture();
const grant = "native:tunnel-fixture";
let ready;
async function setup() {
  devices.advance(Date.now() - devices.now());
  await new NativeMemberships(grace.dependencies).ensure(devicePool.pool, devicePool.organization);
  await grace.dependencies.storage.put("revision", "fixture");
  await grace.dependencies.storage.put("ready-revision", "fixture");
  const control = async (action, values) =>
    devices.nativeControl(new Request("https://pool.example" + nativeControlPath, {
      method: "POST",
      body: JSON.stringify({ envelope: await signEnvelope("${signingKey}", nativeControlPrefix, {
        action, user: owner, grant, models: true, expiresAt: devices.now() + 10_000, ...values }) }),
    }));
  const registered = await control("register", { intent: await devices.intent(owner), name: "Device", tools: true });
  const { computer } = await registered.json();
  return { computer: computer.id, control };
}
// Built when read: workerd's clock reads zero while a module loads.
const status = () => ({ boot_id: "boot-a", started_at: "2026-11-24T00:00:00Z", resume: "v1", policyLeaseUntil: Date.now() + 3_600_000 });
const env = { POOL_APP_SIGNING_KEY: "${signingKey}" };

export class Layer extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const counts = (await this.ctx.storage.get("counts")) ?? {};
    if (url.pathname === "/__fixture/counts") return Response.json(counts);
    const resuming = url.pathname.startsWith("/__basalt/resume/v1/");
    const id = resuming ? url.pathname.split("/").at(-1) : request.headers.get("X-Request-Id");
    const kind = resuming ? "resumes" : "sends";
    counts[id] = { ...counts[id], [kind]: (counts[id]?.[kind] ?? 0) + 1 };
    await this.ctx.storage.put("counts", counts);
    const whole = new TextEncoder().encode(globalThis.fixtureAnswer);
    const from = Number(request.headers.get("X-Basalt-Resume-From") ?? 0);
    let offset = from;
    const body = new ReadableStream({
      async pull(controller) {
        if (offset >= whole.byteLength) return controller.close();
        await new Promise((resolve) => setTimeout(resolve, 40));
        controller.enqueue(whole.slice(offset, offset + 64));
        offset += 64;
      },
    });
    return new Response(body, { headers: {
      "content-type": "text/event-stream", "X-Basalt-Resume": "v1",
      ...(resuming ? { "X-Basalt-Resume-From": String(from), "X-Basalt-Resume-State": "live" } : {}),
    } });
  }
}

// One instance of the pool Worker: its entry and its controller, with the controller's leases.
export class Isolate extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    devices.restart();
    this.layer = () => env.LAYER.get(env.LAYER.idFromName("layer"));
    this.streams = new NativeStreams();
    this.memberships = new NativeMemberships({ ...grace.dependencies, abort: (pool) => this.abortPool(pool) });
    this.lifecycle = new PoolLifecycle(
      { running: () => true, start: async () => {}, stop: async () => {}, keepAlive: async () => {}, status: async () => status() },
      { ...grace.dependencies.storage, getAlarm: async () => null, setAlarm: async () => {} },
      "fixture",
    );
    this.protection = new RuntimeProtection(this.streams, {
      check: async () => status(), defer: (work) => ctx.waitUntil(work), unavailable: () => {},
    });
    const isolate = this;
    this.controller = {
      async fetch(request) {
        if ((await request.clone().text()).includes("before-headers") && !(await ctx.storage.get("cut"))) {
          await ctx.storage.put("cut", true);
          isolate.replace();
          return new Promise(() => {});
        }
        return forwardPoolRequest(request, 8317, {
          ...isolate.admission(),
          lifecycle: Promise.resolve(isolate.lifecycle),
          protection: isolate.protection,
          route: async (forwarded, _port, _pool, legacy) =>
            stampResumeTarget(await legacy(forwarded), { kind: "primary" }),
          fetch: (forwarded) => isolate.layer().fetch(forwarded),
          running: () => true,
          defer: (work) => ctx.waitUntil(work),
        });
      },
      // PoolContainer.resume's own function, with the layer read in place of its container's.
      resume: (input) =>
        governedResume(input, {
          draining: () => false,
          cut: (id) => isolate.streams.wasCut(id) || devices.wasCut(id),
          admit: (call, id) => admitModelCall(call, isolate.admission(), id),
          track: (_request, work) => work(),
          serve: (parsed) =>
            isolate.layer().fetch(new Request("http://pool/__basalt/resume/v1/" + parsed.requestId, {
              headers: { "X-Basalt-Resume-From": String(parsed.from), "X-Basalt-Resume-Boot": parsed.boot },
            })),
          fallback: (id, signal) => isolate.streams.acquire(crypto.randomUUID(), "", signal, id),
          finish: () => undefined,
        }),
    };
  }
  // As the controller's membership abort does (worker.ts).
  abortPool(pool) {
    this.streams.abortPool(pool);
    devices.abortPool(pool);
  }
  admission() {
    return {
      env,
      computers: { nativeModel: devices.nativeModel, observeUsage: async () => {} },
      memberships: this.memberships,
      streams: this.streams,
    };
  }
  replace() {
    setTimeout(() => this.ctx.abort("replaced"), 0);
  }
  async fetch(request) {
    const url = new URL(request.url);
    const how = url.searchParams.get("how");
    if (url.pathname === "/__fixture/setup") return Response.json(await (ready ??= setup()));
    if (url.pathname === "/__fixture/replace") {
      this.replace();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__fixture/end") {
      // Each deliberate end as production makes it: the device revoked through its control path
      // (the registry's sync), the pool's membership abort, the protection abort (the pool's lease
      // set only, as RuntimeProtection holds it).
      if (how === "device") {
        const { computer, control } = await ready;
        const revoked = await control("revoke", { computer, pool: devicePool.pool });
        if (revoked.status !== 200) throw new Error("revoke failed " + revoked.status);
      } else if (how === "pool") this.abortPool(devicePool.pool);
      else if (how === "all") this.streams.abortAll();
      // In the same handler, before anything the revocation sent can leave this instance.
      if (url.searchParams.get("replace") === "sync") this.ctx.abort("replaced");
      if (url.searchParams.has("replace")) this.replace();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === nativeSessionPath) return nativeSession(await devices.nativeSession(request));
    if (url.pathname === routerResumePath)
      return routerResume(request, keys, (input) => this.controller.resume(input));
    return fetchController(request, {
      controller: () => this.controller,
      env: {},
      defer: (work) => this.ctx.waitUntil(work),
      signing: keys,
    });
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    // The tools gateway's answer for the device's bearer: this device, in this pool, with models.
    if (path === "/api/auth/native/access") {
      const { computer } = await (await env.ISOLATE.get(env.ISOLATE.idFromName("pool")).fetch("http://pool/__fixture/setup")).json();
      return Response.json({ id: "${"native:tunnel-fixture"}", userId: owner, clientId: "client",
        expiresAt: Date.now() + 600_000, policy: { kind: "native", computer, pool: devicePool.pool, models: true, toolsOrganization: "organization-a" } });
    }
    // A tools call that streams for a while, as an MCP event stream does.
    if (path === "/mcp") {
      let sent = 0;
      return new Response(new ReadableStream({
        async pull(controller) {
          if (sent >= 60) return controller.close();
          await new Promise((resolve) => setTimeout(resolve, 50));
          controller.enqueue(new TextEncoder().encode("data: tool " + sent++ + "\\n\\n"));
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path === "/__fixture/counts") return env.LAYER.get(env.LAYER.idFromName("layer")).fetch(request);
    return env.ISOLATE.get(env.ISOLATE.idFromName("pool")).fetch(request);
  },
};
`;
const router = `
import { handleTunnel } from "./src/tunnel/host.ts";
export default { fetch: (request, env, ctx) => handleTunnel(request, env, ctx) };
`;

const answer = Array.from(
  { length: 16 },
  (_, index) =>
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part ${index}"}}\n\n`,
)
  .concat('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  .join("");

async function bundle(contents: string, prelude = "") {
  const output = await build({
    stdin: {
      contents,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "module", "import"],
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
    banner: { js: prelude },
    plugins: [
      {
        name: "no-account-database",
        setup(build) {
          build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "unavailable" }));
          build.onLoad({ filter: /.*/, namespace: "unavailable" }, () => ({
            contents:
              "export default { Client: class { constructor() { throw Error('No database'); } } };",
          }));
        },
      },
    ],
  });
  return output.outputFiles[0]!.text;
}

async function workers() {
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const settings = {
    modules: true,
    compatibilityDate: poolWorkerCompatibility.date,
    compatibilityFlags: poolWorkerCompatibility.flags,
  };
  return new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          ...settings,
          // The router keeps its own settings: no request signal.
          compatibilityFlags: ["nodejs_compat"],
          name: "router",
          script: await bundle(router),
          bindings: { POOL_APP_SIGNING_KEY: signingKey },
          serviceBindings: { POOL_SERVICE: "pool", TOOLS_SERVICE: "pool" },
        },
        {
          ...settings,
          name: "pool",
          script: await bundle(pool, `globalThis.fixtureAnswer = ${JSON.stringify(answer)};`),
          durableObjects: {
            ISOLATE: { className: "Isolate", useSQLite: true },
            LAYER: { className: "Layer", useSQLite: true },
          },
          outboundService: () => new Response(null, { status: 403 }),
        },
      ],
    }),
  );
}

type Frame = Record<string, unknown> & { type: string; id?: number };
type Mf = Awaited<ReturnType<typeof workers>>;
const decode = (bytes: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(bytes), (char) => char.charCodeAt(0)));
const poolFetch = async (mf: Mf, path: string) =>
  (await mf.getWorker("pool")).fetch(`http://pool${path}`).catch(
    // An instance ended inside the handler answers with its reset.
    () => new Response(null, { status: 500 }),
  ) as Promise<Response>;

/** A device's session through the real tunnel host, speaking the protocol as the device does. */
async function session(mf: Mf) {
  const response = await mf.dispatchFetch("https://router.example/native/v1/tunnel", {
    headers: {
      upgrade: "websocket",
      "sec-websocket-protocol": tunnelProtocol,
      authorization: "Bearer device",
    },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const frames: Frame[] = [];
  const text = new Map<number, string>();
  let closed: { code: number; reason: string } | undefined;
  const waiters = new Set<() => void>();
  const changed = () => waiters.forEach((wake) => wake());
  const send = (frame: object) => socket.send(JSON.stringify({ v: 1, ...frame }));
  socket.addEventListener("message", (event: { data: string }) => {
    const frame = JSON.parse(event.data) as Frame;
    frames.push(frame);
    if (frame.type === "data") {
      text.set(frame.id!, (text.get(frame.id!) ?? "") + decode(frame.bytes as string));
      send({ type: "credit", id: frame.id, bytes: atob(frame.bytes as string).length });
    }
    changed();
  });
  socket.addEventListener("close", (event: { code: number; reason: string }) => {
    closed = { code: event.code, reason: event.reason };
    changed();
  });
  socket.accept();
  const until = (done: () => boolean, ms = 15_000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error("timed out"));
      }, ms);
      const check = () => {
        if (!done()) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve();
      };
      waiters.add(check);
      check();
    });
  await until(() => frames.some((frame) => frame.type === "ready"));
  return {
    frames,
    text: (id: number) => text.get(id) ?? "",
    closed: () => closed,
    until,
    tools(id: number) {
      send({
        type: "open",
        id,
        headers: { accept: "text/event-stream" },
        operation: { service: "tools", method: "GET", path: "/mcp", transport: "http" },
      });
      send({ type: "end", id });
      send({ type: "credit", id, bytes: 65_536 });
    },
    call(id: number, body = "{}") {
      send({
        type: "open",
        id,
        headers: { "content-type": "application/json" },
        operation: { service: "models", method: "POST", path: "/v1/messages", transport: "http" },
      });
      send({
        type: "data",
        id,
        bytes: encodeTunnelBytes(new TextEncoder().encode(body)),
        text: false,
      });
      send({ type: "end", id });
      send({ type: "credit", id, bytes: 65_536 });
    },
    ended: (id: number) =>
      frames.some((frame) => frame.id === id && (frame.type === "end" || frame.type === "error")),
    error: (id: number) => frames.find((frame) => frame.id === id && frame.type === "error"),
  };
}

async function started(context: TestContext) {
  if (!process.env.FIXTURE_LOGS)
    for (const level of ["info", "warn", "error"] as const)
      context.mock.method(console, level, () => {});
  const mf = await workers();
  context.after(() => mf.dispose());
  await poolFetch(mf, "/__fixture/setup");
  const counts = async () =>
    Object.values(
      (await (await poolFetch(mf, "/__fixture/counts")).json()) as Record<
        string,
        { sends?: number; resumes?: number }
      >,
    );
  return { mf, device: await session(mf), counts };
}
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "a streamed tunnel call survives its controller's replacement: every byte once, then its terminal",
  { timeout: 60_000 },
  async (context) => {
    const { mf, device, counts } = await started(context);
    device.call(1);
    await device.until(() => device.text(1).includes('part 2"'));
    await poolFetch(mf, "/__fixture/replace");
    await device.until(() => device.ended(1) || device.closed() !== undefined);
    assert.equal(device.text(1), answer, "every byte exactly once, no gap and no repeat");
    assert.ok(device.frames.some((frame) => frame.id === 1 && frame.type === "end"));
    assert.deepEqual(await counts(), [{ sends: 1, resumes: 1 }]);
    // Nothing more to do: the session that lost its lease ends with its last operation.
    await device.until(() => device.closed() !== undefined);
    assert.equal(device.closed()!.code, 1000);
  },
);

test(
  "a tunnel call whose answer had not begun is sent again once its controller is back",
  { timeout: 60_000 },
  async (context) => {
    const { device } = await started(context);
    device.call(1, '{"case":"before-headers"}');
    await device.until(() => device.ended(1) || device.closed() !== undefined);
    assert.equal(device.text(1), answer);
    assert.ok(device.frames.some((frame) => frame.id === 1 && frame.type === "end"));
  },
);

test(
  "a session whose lease went away takes no new operation",
  { timeout: 60_000 },
  async (context) => {
    const { mf, device } = await started(context);
    device.call(1);
    await device.until(() => device.text(1).includes('part 2"'));
    await poolFetch(mf, "/__fixture/replace");
    // Past the replacement, with the first call still being resumed.
    await settle(200);
    device.call(2);
    await device.until(() => device.ended(2));
    assert.deepEqual(device.error(2), {
      v: 1,
      type: "error",
      id: 2,
      code: "unavailable",
      outcome: "not-started",
    });
    await device.until(() => device.ended(1));
    assert.equal(device.text(1), answer);
  },
);

test(
  "revoking the device with its lease live cuts its call at once and ends the session",
  { timeout: 60_000 },
  async (context) => {
    const { mf, device, counts } = await started(context);
    device.call(1);
    await device.until(() => device.text(1).includes('part 2"'));
    await poolFetch(mf, "/__fixture/end?how=device");
    await device.until(() => device.closed() !== undefined, 2_000);
    await settle(1_500);
    assert.ok(!device.text(1).includes("message_stop"));
    assert.deepEqual(await counts(), [{ sends: 1 }], "nothing resumes it");
  },
);

for (const how of ["device", "pool", "all"] as const)
  test(
    `a deliberate end (${how}) after the session lost its lease cuts the resumed part: no byte after`,
    { timeout: 60_000 },
    async (context) => {
      const { mf, device, counts } = await started(context);
      device.call(1);
      await device.until(() => device.text(1).includes('part 2"'));
      await poolFetch(mf, "/__fixture/replace");
      // The session outlived its lease and the call was resumed in the new instance.
      await device.until(() => device.text(1).includes('part 6"'));
      const resumed = device.text(1).length;
      await poolFetch(mf, `/__fixture/end?how=${how}`);
      await device.until(() => device.ended(1) || device.closed() !== undefined, 5_000);
      await settle(1_500);
      assert.ok(!device.text(1).includes("message_stop"), "the answer did not finish");
      assert.ok(device.text(1).length - resumed <= 256, "at most what was already on the wire");
      assert.deepEqual(await counts(), [{ sends: 1, resumes: 1 }], "no resume after the cut");
    },
  );

test(
  "a device revoked in the same turn as a replacement: its call ends and nothing resumes it",
  { timeout: 60_000 },
  async (context) => {
    const { mf, device, counts } = await started(context);
    device.call(1);
    await device.until(() => device.text(1).includes('part 2"'));
    await poolFetch(mf, "/__fixture/end?how=device&replace=1");
    await device.until(() => device.ended(1) || device.closed() !== undefined, 15_000);
    await settle(500);
    assert.ok(!device.text(1).includes("message_stop"));
    assert.deepEqual(await counts(), [{ sends: 1 }], "the layer is never asked for the rest");
    // Whichever reaches the router first, the pool's close (the session ends) or the replacement (the
    // session outlives its lease and the router's resume is refused), the call ends with nothing more.
    assert.ok(device.closed() !== undefined || device.error(1)?.type === "error");
  },
);

test(
  "a device revoked and its controller replaced in one step: the resume is refused at the pool",
  { timeout: 60_000 },
  async (context) => {
    const { mf, device, counts } = await started(context);
    device.call(1);
    await device.until(() => device.text(1).includes('part 2"'));
    await poolFetch(mf, "/__fixture/end?how=device&replace=sync");
    await device.until(() => device.ended(1) || device.closed() !== undefined, 15_000);
    await settle(500);
    assert.ok(!device.text(1).includes("message_stop"), "the rest never arrives");
    assert.deepEqual(await counts(), [{ sends: 1 }], "the layer is never asked for the rest");
    // The lease went away with the instance, so the session lived on to hear its call refused.
    assert.deepEqual(device.error(1), {
      v: 1,
      type: "error",
      id: 1,
      code: "unavailable",
      outcome: "unknown",
    });
  },
);

test(
  "a tools call, which the pool does not govern, ends when its session loses its lease",
  { timeout: 60_000 },
  async (context) => {
    const { mf, device } = await started(context);
    device.tools(1);
    await device.until(() => device.text(1).includes("tool 2"));
    await poolFetch(mf, "/__fixture/replace");
    await device.until(() => device.ended(1), 5_000);
    assert.deepEqual(device.error(1), {
      v: 1,
      type: "error",
      id: 1,
      code: "interrupted",
      outcome: "unknown",
    });
    const at = device.text(1).length;
    await device.until(() => device.closed() !== undefined, 5_000);
    await settle(300);
    assert.equal(device.text(1).length, at, "nothing after its end");
  },
);
