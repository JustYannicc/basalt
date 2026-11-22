import { RuntimeMap } from "../../scripts/pool-tests/runtime-map.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, test } from "node:test";
import type { NativeStreamLease } from "./native-streams.ts";
import type { TerminalOutcome } from "./terminal-protocol.ts";

// Worker modules get their platform declarations in tsconfig.worker.json.
const resumeModule = "./stream-resume.worker.ts";
const { resumedAnswer } = (await import(resumeModule)) as {
  resumedAnswer(
    answer: Response,
    deps: {
      from: number;
      lease: NativeStreamLease;
      finish?: (outcome: TerminalOutcome, status: number, bytes: number) => void;
    },
  ): Response;
};

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query(text, values) { return { rows: text.includes('SELECT k.id') ? [{ id: 73, channels: [], username: null }] : [{ active: false }] }; } async end() {} } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
// The Worker gets its platform declarations in tsconfig.worker.json.
const workerModule = "./worker.ts";
const {
  PoolContainer,
}: {
  PoolContainer: new (
    ctx: object,
    env: object,
  ) => {
    alarm(): Promise<void>;
    fetch(request: Request): Promise<Response>;
    resume(input: unknown): Promise<Response>;
    deploymentIdentity(caller?: unknown): { candidate: string };
  };
} = await import(workerModule);
after(() => hooks.deregister());

const requestId = "0b5c3a4e-8f1d-4c2b-9a7e-3d6f1e2a4b5c";
const encoder = new TextEncoder();

function lease() {
  let released = 0;
  const abort = new AbortController();
  return {
    released: () => released,
    value: {
      signal: abort.signal,
      release: () => {
        released++;
        return true;
      },
      onClose: () => {},
    },
  };
}

test("a resumed answer holds its lease until it ends and records the call's outcome once", async () => {
  const finished: [string, number, number][] = [];
  const held = lease();
  const answer = resumedAnswer(new Response("rest of the answer"), {
    from: 100,
    lease: held.value,
    finish: (outcome, status, bytes) => finished.push([outcome, status, bytes]),
  });
  assert.equal(held.released(), 0);
  assert.equal(await answer.text(), "rest of the answer");
  assert.equal(held.released(), 1);
  assert.deepEqual(finished, [["complete", 200, 100 + "rest of the answer".length]]);

  const cancelled: string[] = [];
  const left = lease();
  const open = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("part"));
    },
  });
  const reading = resumedAnswer(new Response(open), {
    from: 0,
    lease: left.value,
    finish: (outcome) => cancelled.push(outcome),
  });
  await reading.body!.cancel("client left");
  assert.deepEqual(cancelled, ["client_closed"]);
  assert.equal(left.released(), 1);
});

test("the controller resumes a call through its container's front layer and refuses what it cannot resume", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-21T16:00:00Z") });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
  let alarm: number | null = null;
  const storage = new Map<string, unknown>();
  const waitUntil: Promise<unknown>[] = [];
  const pool = "fake-pool";
  storage.set("computer-registry-v1", {
    "computer-73": {
      id: "computer-73",
      name: "Fixture",
      user: "response-owner",
      pool,
      createdAt: "2026-01-01T00:00:00.000Z",
      boundAt: "2026-01-01T00:00:00.000Z",
      state: "active",
      keyId: 73,
      userId: 1,
      toolsKeyId: "tools-key-73",
      toolsHash: "tools-hash-73",
      firstModelRequestAt: null,
      firstToolCallAt: null,
      revokedAt: null,
    },
  });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 200 }));
  const resumes: { port: number; path: string; from: string | null; boot: string | null }[] = [];
  const modelCalls: { port: number; headers: Headers }[] = [];
  let advert = false;
  const container = {
    running: true,
    destroy: async () => {
      container.running = false;
    },
    start: () => {
      container.running = true;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          if (port === 8318)
            return Response.json({
              boot_id: "fixture-boot",
              started_at: "2026-01-01T00:00:00Z",
              ...(advert ? { resume: "v1" } : {}),
            });
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path.startsWith("/__basalt/resume/v1/")) {
            resumes.push({
              port,
              path,
              from: request.headers.get("X-Basalt-Resume-From"),
              boot: request.headers.get("X-Basalt-Resume-Boot"),
            });
            return new Response("rest", {
              headers: {
                "X-Basalt-Resume": "v1",
                "X-Basalt-Resume-From": request.headers.get("X-Basalt-Resume-From") ?? "",
              },
            });
          }
          if (request.method === "POST" && path === "/v1/responses") {
            modelCalls.push({ port, headers: request.headers });
            return Response.json({ ok: true });
          }
          if (port === 8327) {
            const endpoint = path.slice("/v8/management".length);
            if (endpoint === "/channel-groups")
              return Response.json({
                channel_groups: [{ id: 20, channel_name: `signalbox-pool-${pool}` }],
              });
            if (endpoint.startsWith("/channel-group-details"))
              return Response.json({
                channel_group_details: [{ id: 1, channel_group_id: 20, auth_id: "account" }],
              });
            if (endpoint === "/capabilities") return Response.json({ capabilities: {} });
            return Response.json({});
          }
          return new Response(null, { status: 404 });
        },
      };
    },
  };
  const ctx = {
    id: { toString: () => "a".repeat(64) },
    container,
    abort: () => {},
    waitUntil: (work: Promise<unknown>) => {
      waitUntil.push(work);
    },
    storage: Object.assign(new RuntimeMap(storage), {
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
      },
    }),
  };
  const worker = new PoolContainer(ctx, {
    TOOLS_SERVICE: { fetch: async () => new Response(null, { status: 204 }) },
    POOL_DATABASE_URL: "postgres://fixture:fixture@database.invalid/fixture",
    POOL_MANAGEMENT_KEY: "fixture-management-key",
    POOL_AUTH_DATABASE: { connectionString: "postgres://fixture" },
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: "fixture-image",
  });
  const drain = async () => {
    for (let i = 0; i < waitUntil.length; i++) await waitUntil[i];
  };
  await worker.alarm();
  await drain();

  const modelCall = async () =>
    (
      await worker.fetch(
        new Request("https://pool.example/v1/responses", {
          method: "POST",
          headers: {
            Authorization: "Bearer private-model-request-key-73",
            // A caller's own marks never reach the container.
            "X-Basalt-Resumable": "1",
            "X-Basalt-Resume-Eligible": "1",
          },
          body: "{}",
        }),
      )
    ).text();
  const input = { requestId, from: 42, target: "primary", boot: "fixture-boot" };

  // No advert: the call goes to the node's port unmarked, as today, and nothing is resumed.
  await modelCall();
  assert.equal(modelCalls.at(-1)?.port, 8317);
  assert.equal(modelCalls.at(-1)?.headers.get("X-Basalt-Resumable"), null);
  assert.equal(modelCalls.at(-1)?.headers.get("X-Basalt-Resume-Eligible"), null);
  assert.equal((await worker.resume(input)).status, 410);
  assert.deepEqual(resumes, [], "a container without the layer is never asked");

  // With the layer's advert, the call is marked and sent to the layer's own port.
  advert = true;
  await modelCall();
  assert.equal(modelCalls.at(-1)?.port, 8316);
  assert.equal(modelCalls.at(-1)?.headers.get("X-Basalt-Resumable"), "1");
  assert.equal(modelCalls.at(-1)?.headers.get("X-Basalt-Resume-Eligible"), null);
  const resumed = await worker.resume(input);
  assert.equal(resumed.status, 200);
  assert.equal(await resumed.text(), "rest");
  assert.deepEqual(resumes, [
    { port: 8316, path: `/__basalt/resume/v1/${requestId}`, from: "42", boot: "fixture-boot" },
  ]);

  for (const bad of [{ ...input, requestId: "x" }, { ...input, target: "elsewhere" }, null]) {
    const refused = await worker.resume(bad);
    assert.equal(refused.status, 410);
    assert.equal(refused.headers.get("X-Basalt-Resume-State"), "gone");
  }

  // A stopped container's answers went with it, and it is not started to look.
  container.running = false;
  assert.equal((await worker.resume(input)).status, 410);
  assert.equal(container.running, false);
  container.running = true;

  // While the controller hands over to other code, a resume is refused like any model call.
  worker.deploymentIdentity({ candidate: "f".repeat(40), workerInput: "e".repeat(64) });
  await drain();
  assert.equal((await worker.resume(input)).status, 410);
  assert.equal(resumes.length, 1);
});
