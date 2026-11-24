import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { nativeModelHeader, nativeModelPrefix } from "./native-contract.ts";
import { routerAttemptHeader, signRouterAttempt } from "./router-attempt.ts";
import { routerResumeHeader, routerResumePath } from "./router-resume-contract.ts";
import { owner, pool as devicePool } from "./test/computers.ts";
import { signEnvelope } from "./token.ts";
import { poolWorkerCompatibility } from "./worker-compatibility.ts";

// A resumed answer is governed as a first answer is. Real workerd, the pool split as in production:
// the entry (real `handlePoolWorkerRequest`) and the controller in their own objects, the controller
// admitting first calls with the real `forwardPoolRequest` and resumes with the real
// `governedResume` that `PoolContainer.resume` runs, over its two lease sets: the
// device registry's (real `Computers`, a device registered and revoked through its signed control
// path) and the pool's (real `NativeMemberships`). Registry and memberships live at module level, as
// durable storage outlives an instance; leases live in each instance. The container's front layer is
// an object that outlives both. The test sends the resume the router sends after a cut, on the real
// route, so each case is exact; `src/model-resume.workerd.test.ts` proves the cut and the router's
// resume across runtimes.
const signingKey = "ab".repeat(32);
const key = "home-key-active";

const pool = `
import { DurableObject } from "cloudflare:workers";
import { handlePoolWorkerRequest } from "./src/pool/worker.ts";
import { admitModelCall, forwardPoolRequest } from "./src/pool/forward.worker.ts";
import { governedResume } from "./src/pool/resume-admission.worker.ts";
import { stampResumeTarget } from "./src/pool/stream-resume.ts";
import { resumedTerminal } from "./src/pool/terminal-recording.worker.ts";
import { NativeStreams } from "./src/pool/native-streams.ts";
import { NativeMemberships } from "./src/pool/membership.ts";
import { PoolLifecycle } from "./src/pool/lifecycle.ts";
import { RuntimeProtection } from "./src/pool/runtime-protection.ts";
import { nativeControlPath, nativeControlPrefix } from "./src/pool/native-contract.ts";
import { signEnvelope } from "./src/pool/token.ts";
import { fixture as computersFixture, owner, pool as devicePool } from "./src/pool/test/computers.ts";
import { membershipGraceFixture } from "./scripts/pool-tests/membership-grace-fixture.ts";

// Durable across a replacement, as storage is.
const devices = computersFixture();
const grace = membershipGraceFixture();
const keys = globalThis.fixtureKeys;
const records = { starts: [], finishes: [], resumedFinishes: [], usage: 0, refused: [] };
const recorder = {
  start: async (input) => void records.starts.push(input.requestId),
  finish: async (id, result) => void records.finishes.push({ id, outcome: result.outcome }),
};
const resumedRecorder = {
  finish: async (id, result) => void records.resumedFinishes.push({ id, outcome: result.outcome }),
};
let ready;
async function setup(withMemberships) {
  // The device fixture's clock starts in the past; assertions here are signed against the real one.
  devices.advance(Date.now() - devices.now());
  // Without a membership the pool admits no pool lease, as a pool without one configured does.
  if (withMemberships) {
    const memberships = new NativeMemberships(grace.dependencies);
    await memberships.ensure(devicePool.pool, devicePool.organization);
    // Another pool, which a key may move to.
    await memberships.ensure("pool-b", "organization-b");
  }
  await grace.dependencies.storage.put("revision", "fixture");
  await grace.dependencies.storage.put("ready-revision", "fixture");
  const grant = "native:resume-fixture";
  const control = async (action, values) =>
    devices.nativeControl(new Request("https://pool.example" + nativeControlPath, {
      method: "POST",
      body: JSON.stringify({ envelope: await signEnvelope("${signingKey}", nativeControlPrefix, {
        action, user: owner, grant, models: true, expiresAt: devices.now() + 10_000, ...values }) }),
    }));
  const registered = await control("register", { intent: await devices.intent(owner), name: "Device", tools: true });
  const { computer } = await registered.json();
  return { computer: computer.id, grant, control };
}
// Built when read: workerd's clock reads zero while a module loads.
const status = () => ({ boot_id: "boot-a", started_at: "2026-11-24T00:00:00Z", resume: "v1", policyLeaseUntil: Date.now() + 3_600_000 });
const env = { POOL_APP_SIGNING_KEY: "${signingKey}", POOL_AUTH_DATABASE: { connectionString: "fixture" } };

export class Layer extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const counts = (await this.ctx.storage.get("counts")) ?? {};
    if (url.pathname === "/__fixture/counts") return Response.json(counts);
    if (url.pathname === "/__fixture/stop") {
      await this.ctx.storage.put("stopped", true);
      return new Response(null, { status: 204 });
    }
    const resuming = url.pathname.startsWith("/__basalt/resume/v1/");
    const id = resuming ? url.pathname.split("/").at(-1) : request.headers.get("X-Request-Id");
    const kind = resuming ? "resumes" : "sends";
    counts[id] = { ...counts[id], [kind]: (counts[id]?.[kind] ?? 0) + 1 };
    await this.ctx.storage.put("counts", counts);
    if (resuming && (await this.ctx.storage.get("stopped")))
      return new Response(null, { status: 410, headers: { "X-Basalt-Resume-State": "gone" } });
    if (!resuming) await this.ctx.storage.put("shape:" + id, url.pathname.endsWith("/chat/completions") ? "chat" : "messages");
    const shape = await this.ctx.storage.get("shape:" + id);
    const whole = new TextEncoder().encode(globalThis.fixtureAnswers[shape]);
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

export class Controller extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    devices.restart();
    this.instance = crypto.randomUUID();
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
  }
  // As the controller's membership abort does (worker.ts).
  abortPool(pool) {
    this.streams.abortPool(pool);
    devices.abortPool(pool);
  }
  admission() {
    return {
      env,
      computers: { nativeModel: devices.nativeModel, observeUsage: async () => void records.usage++ },
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
    if (url.pathname === "/__fixture/setup")
      return Response.json(await (ready ??= setup(url.searchParams.get("memberships") !== "0")));
    if (url.pathname === "/__fixture/records") return Response.json({ ...records, leases: this.streams.active, instance: this.instance });
    if (url.pathname === "/__fixture/end") {
      // Each deliberate end, as production makes it: a device revoked through its control path
      // (the registry's sync), the pool's membership abort, the protection abort on a boot change.
      if (how === "device") {
        const { computer, control } = await ready;
        const revoked = await control("revoke", { computer, pool: devicePool.pool });
        if (revoked.status !== 200) throw new Error("revoke failed " + revoked.status);
      } else if (how === "pool") this.abortPool(devicePool.pool);
      else if (how === "all") this.streams.abortAll();
      else if (how === "key") keys.delete("${key}");
      else if (how === "move") globalThis.fixtureKeyPool = "pool-b";
      if (url.searchParams.has("replace")) this.replace();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__fixture/replace") {
      this.replace();
      return new Response(null, { status: 204 });
    }
    return forwardPoolRequest(request, 8317, {
      ...this.admission(),
      terminal: recorder,
      lifecycle: Promise.resolve(this.lifecycle),
      protection: this.protection,
      route: async (forwarded, _port, _pool, legacy) =>
        stampResumeTarget(await legacy(forwarded), { kind: "primary" }),
      fetch: (forwarded) => this.layer().fetch(forwarded),
      running: () => true,
      defer: (work) => this.ctx.waitUntil(work),
    });
  }
  // PoolContainer.resume's own function, with the layer read in place of its container's.
  resume(input) {
    return governedResume(input, {
      draining: () => false,
      cut: (id) => {
        const cut = this.streams.wasCut(id) || devices.wasCut(id);
        if (cut) records.refused.push("cut");
        return cut;
      },
      admit: async (call, id) => {
        try {
          return await admitModelCall(call, this.admission(), id);
        } catch (error) {
          records.refused.push("refused");
          throw error;
        }
      },
      track: (_request, work) => work(),
      serve: (parsed) =>
        this.layer().fetch(new Request("http://pool/__basalt/resume/v1/" + parsed.requestId, {
          headers: { "X-Basalt-Resume-From": String(parsed.from), "X-Basalt-Resume-Boot": parsed.boot },
        })),
      fallback: (id, signal) => this.streams.acquire(crypto.randomUUID(), "", signal, id),
      finish: (id) => resumedTerminal(env, id, (work) => this.ctx.waitUntil(work), resumedRecorder),
    });
  }
}

// The pool Worker's entry, in an object so a replacement can end it with the controller.
export class Entry extends DurableObject {
  fetch(request) {
    if (new URL(request.url).pathname === "/__fixture/replace") {
      setTimeout(() => this.ctx.abort("replaced"), 0);
      return new Response(null, { status: 204 });
    }
    const controller = this.env.CONTROLLER.get(this.env.CONTROLLER.idFromName("control"));
    return handlePoolWorkerRequest(
      request,
      { ...this.env, ...env, PoolContainer: { jurisdiction: () => ({ getByName: () => controller }) } },
      async (_connection, candidates) => candidates.some((value) => keys.has(value)),
      (work) => this.ctx.waitUntil(work),
    );
  }
}

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/__fixture/counts" || path === "/__fixture/stop")
      return env.LAYER.get(env.LAYER.idFromName("layer")).fetch(request);
    if (path.startsWith("/__fixture/") && path !== "/__fixture/replace-entry")
      return env.CONTROLLER.get(env.CONTROLLER.idFromName("control")).fetch(request);
    if (path === "/__fixture/replace-entry")
      return env.ENTRY.get(env.ENTRY.idFromName("entry")).fetch(new Request("http://pool/__fixture/replace"));
    return env.ENTRY.get(env.ENTRY.idFromName("entry")).fetch(request);
  },
};
`;

const answers = {
  messages: Array.from(
    { length: 16 },
    (_, index) =>
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"part ${index}"}}\n\n`,
  )
    .concat('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    .join(""),
  chat: Array.from(
    { length: 16 },
    (_, index) =>
      `data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"part ${index}"}}]}\n\n`,
  )
    .concat("data: [DONE]\n\n")
    .join(""),
};

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
        // The key and scope tables, as the pool reads them: one key, scoped to the device's pool.
        name: "fixture-database",
        setup(build) {
          build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "fixture" }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents: `export default { Client: class {
              constructor() { this.connection = { stream: { destroy() {} } }; }
              on() {} async connect() {} async end() {}
              async query(text, values) {
                if (text.includes("FROM api_key")) return { rows: globalThis.fixtureKeys.has(values[0])
                  ? [{ id: 7, channels: [1], username: globalThis.fixtureUser }] : [] };
                if (text.includes("FROM channel_group")) return { rows: [{ id: 1, channel_name: "signalbox-pool-" + (globalThis.fixtureKeyPool ?? "pool-a") }] };
                return { rows: [] };
              }
            } };`,
          }));
        },
      },
    ],
  });
  return output.outputFiles[0]!.text;
}

async function workers() {
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const { backendUserName } = await import("./backend-users.ts");
  const prelude = `globalThis.fixtureKeys ??= new Set(${JSON.stringify([key])});
globalThis.fixtureUser = ${JSON.stringify(backendUserName("user-owner", "pool-a"))};
globalThis.fixtureAnswers = ${JSON.stringify(answers)};`;
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
          name: "pool",
          script: await bundle(pool, prelude),
          durableObjects: {
            ENTRY: { className: "Entry", useSQLite: true },
            CONTROLLER: { className: "Controller", useSQLite: true },
            LAYER: { className: "Layer", useSQLite: true },
          },
          outboundService: () => new Response(null, { status: 403 }),
        },
      ],
    }),
  );
}

type Mf = Awaited<ReturnType<typeof workers>>;
const fixture = async (mf: Mf, path: string, init?: RequestInit) =>
  (await mf.getWorker("pool")).fetch(`http://pool${path}`, init) as Promise<Response>;
const terminal = { messages: "message_stop", chat: "[DONE]" };
const pathOf = (shape: "messages" | "chat") =>
  shape === "chat" ? "/v1/chat/completions" : "/v1/messages";

/** The caller's own credentials, as the router sends them on every send: a key, or a fresh assertion. */
async function credentials(
  device: string | undefined,
  shape: "messages" | "chat",
): Promise<Record<string, string>> {
  if (!device) return { "x-api-key": key };
  return {
    [nativeModelHeader]: await signEnvelope(signingKey, nativeModelPrefix, {
      user: owner,
      grant: "native:resume-fixture",
      computer: device,
      pool: devicePool.pool,
      method: "POST",
      path: pathOf(shape),
      expiresAt: Date.now() + 25_000,
    }),
  };
}

/** Reads a stream until `until` is in it, or to its end or failure. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until?: string) {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    let next;
    try {
      next = await reader.read();
    } catch {
      return { text, bytes, failed: true, done: false };
    }
    if (next.done) return { text, bytes, failed: false, done: true };
    bytes += next.value.byteLength;
    text += decoder.decode(next.value, { stream: true });
    if (until && text.includes(until)) return { text, bytes, failed: false, done: false };
  }
}

async function started(context: TestContext, memberships = true) {
  if (!process.env.FIXTURE_LOGS)
    for (const level of ["info", "warn", "error"] as const)
      context.mock.method(console, level, () => {});
  const mf = await workers();
  context.after(() => mf.dispose());
  const { computer } = (await (
    await fixture(mf, `/__fixture/setup?memberships=${memberships ? 1 : 0}`)
  ).json()) as {
    computer: string;
  };
  const counts = async (requestId: string) =>
    (((await (await fixture(mf, "/__fixture/counts")).json()) as Record<string, object>)[
      requestId
    ] ?? {}) as { sends?: number; resumes?: number };
  const records = async () =>
    (await (await fixture(mf, "/__fixture/records")).json()) as {
      starts: string[];
      finishes: { id: string; outcome: string }[];
      resumedFinishes: { id: string; outcome: string }[];
      usage: number;
      refused: string[];
      leases: number;
    };
  /** A first call, read to part 2 as a client reads it before its pool's isolate goes down. */
  const first = async (options: { device?: string; shape?: "messages" | "chat" } = {}) => {
    const shape = options.shape ?? "messages";
    const requestId = crypto.randomUUID();
    const response = await fixture(mf, pathOf(shape), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await credentials(options.device, shape)),
        // As a router that resumes names its sends.
        [routerAttemptHeader]: await signRouterAttempt(signingKey, {
          requestId,
          attempt: 1,
          resume: true,
        }),
      },
      body: JSON.stringify({ model: "fixture", stream: true }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const stamp = response.headers.get(routerResumeHeader);
    assert.ok(stamp, "the entry stamped the answer resumable");
    const reader = response.body!.getReader();
    const read = await readUntil(reader, "part 2");
    // The first answer's reader is gone with its isolate.
    await reader.cancel();
    let attempt = 2;
    /** The resume the router sends after the cut, with the call's own credentials. */
    const resume = async (from = read.bytes, withCredentials = true) =>
      fixture(mf, routerResumePath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(withCredentials ? await credentials(options.device, shape) : {}),
          [routerAttemptHeader]: await signRouterAttempt(signingKey, {
            requestId,
            attempt: ++attempt,
          }),
        },
        body: JSON.stringify({ stamp, from, method: "POST", path: pathOf(shape) }),
      });
    return { requestId, shape, read, resume };
  };
  return { mf, computer, counts, records, first };
}

for (const caller of ["key", "device"] as const)
  test(
    `a ${caller} caller still allowed is resumed with every byte once, and one record`,
    { timeout: 60_000 },
    async (context) => {
      const f = await started(context);
      const call = await f.first(caller === "device" ? { device: f.computer } : {});
      await fixture(f.mf, "/__fixture/replace");
      const resumed = await call.resume();
      assert.equal(resumed.status, 200);
      const reader = resumed.body!.getReader();
      const head = await readUntil(reader, "part 9");
      const leases = (await f.records()).leases;
      const rest = await readUntil(reader);
      assert.equal(call.read.text + head.text + rest.text, answers.messages, "every byte once");
      assert.deepEqual(await f.counts(call.requestId), { sends: 1, resumes: 1 });
      const records = await f.records();
      // One call, one record: its start written once, one use counted, the resumed part's one finish.
      assert.deepEqual(records.starts, [call.requestId]);
      assert.equal(records.usage, 1);
      assert.deepEqual(records.resumedFinishes, [{ id: call.requestId, outcome: "complete" }]);
      assert.equal(leases, 1, "the resumed part holds one pool lease, as a first answer does");
      assert.deepEqual(records.refused, []);
    },
  );

for (const caller of ["key", "device"] as const)
  test(
    `a resume without the ${caller} caller's credentials is refused`,
    { timeout: 60_000 },
    async (context) => {
      const f = await started(context);
      const call = await f.first(caller === "device" ? { device: f.computer } : {});
      const refused = await call.resume(call.read.bytes, false);
      assert.equal(refused.status, 410);
      await refused.body?.cancel();
      assert.deepEqual(await f.counts(call.requestId), { sends: 1 });
    },
  );

// [end, shape, caller, pool admission]: a pool without a membership admits device calls on the
// device's own lease alone.
const ends = [
  ["device", "messages", "device", true],
  ["pool", "messages", "key", true],
  ["all", "messages", "key", true],
  ["all", "chat", "key", true],
  ["device", "messages", "device", false],
  ["pool", "messages", "device", false],
] as const;
for (const [how, shape, caller, memberships] of ends)
  test(
    `a deliberate end (${how}) of a ${caller} caller's resumed ${shape} part${memberships ? "" : ", no pool admission,"} ends it: no byte after, no further resume`,
    { timeout: 60_000 },
    async (context) => {
      const f = await started(context, memberships);
      const call = await f.first({ shape, ...(caller === "device" ? { device: f.computer } : {}) });
      await fixture(f.mf, "/__fixture/replace");
      const resumed = await call.resume();
      assert.equal(resumed.status, 200);
      const reader = resumed.body!.getReader();
      const head = await readUntil(reader, "part 5");
      await fixture(f.mf, `/__fixture/end?how=${how}`);
      const rest = await readUntil(reader);
      const delivered = call.read.text + head.text + rest.text;
      assert.ok(!delivered.includes(terminal[shape]), "the answer did not finish");
      assert.ok(rest.failed, "the resumed part ends at the cut");
      assert.ok(rest.text.length <= 128, "at most what was already on the wire");
      // The router's next try after that cut is refused, and the layer is never asked again.
      const again = await call.resume(call.read.bytes + head.bytes + rest.bytes);
      assert.equal(again.status, 410);
      await again.body?.cancel();
      assert.deepEqual(await f.counts(call.requestId), { sends: 1, resumes: 1 });
    },
  );

for (const [how, memberships] of [
  ["device", true],
  ["key", true],
  ["key", false],
] as const)
  test(
    `a ${how} revoked in the same turn as a replacement${memberships ? "" : ", no pool admission"}: the resume is refused`,
    { timeout: 60_000 },
    async (context) => {
      const f = await started(context, memberships);
      const call = await f.first(how === "device" ? { device: f.computer } : {});
      await fixture(f.mf, `/__fixture/end?how=${how}&replace=1`);
      const refused = await call.resume();
      assert.equal(refused.status, 410);
      await refused.body?.cancel();
      assert.deepEqual(await f.counts(call.requestId), { sends: 1 }, "the layer is never asked");
      if (how === "device") assert.deepEqual((await f.records()).refused, ["refused"]);
    },
  );

test(
  "a cell stopped while its answer streams: the rest is gone",
  { timeout: 60_000 },
  async (context) => {
    const f = await started(context);
    const call = await f.first();
    await fixture(f.mf, "/__fixture/stop");
    await fixture(f.mf, "/__fixture/replace");
    const gone = await call.resume();
    assert.equal(gone.status, 410);
    await gone.body?.cancel();
  },
);

test(
  "a key moved to another pool, across a replacement: its resume is refused",
  { timeout: 60_000 },
  async (context) => {
    const f = await started(context);
    const call = await f.first();
    await fixture(f.mf, "/__fixture/end?how=move&replace=1");
    const refused = await call.resume();
    assert.equal(refused.status, 410);
    await refused.body?.cancel();
    assert.deepEqual(await f.counts(call.requestId), { sends: 1 }, "the layer is never asked");
  },
);
