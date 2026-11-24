import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeStreamLease } from "./native-streams.ts";

// A dynamic import keeps the Worker module out of the Node typecheck.
const resumeModule = "./resume-admission.worker.ts";
const { governedResume } = (await import(resumeModule)) as {
  governedResume(input: unknown, deps: object): Promise<Response>;
};

const requestId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const call = {
  method: "POST",
  path: "/v1/messages",
  headers: [["x-api-key", "k"]],
  pool: "pool-a",
};
const input = { requestId, from: 10, target: "primary", boot: "boot-a", call };

function lease() {
  let released = 0;
  const value = {
    signal: new AbortController().signal,
    release: () => Boolean(++released),
    onClose: () => {},
  } as NativeStreamLease;
  return { value, released: () => released };
}

function deps(overrides: Record<string, unknown> = {}) {
  const device = lease();
  const pool = lease();
  return {
    device,
    pool,
    deps: {
      draining: () => false,
      cut: () => false,
      admit: async () => ({
        native: { ...device.value, pool: "pool-a" },
        modelLease: pool.value,
        identity: { pool: "pool-a" },
      }),
      track: (_request: Request, work: () => Promise<Response>) => work(),
      serve: async () => new Response("rest"),
      fallback: () => lease().value,
      finish: () => undefined,
      ...overrides,
    },
  };
}

test("a handover that begins during a resume's admission refuses it and keeps no lease", async (context) => {
  context.mock.method(console, "info", () => {});
  let draining = false;
  const f = deps({
    draining: () => draining,
    admit: async () => {
      draining = true;
      return {
        native: { ...f.device.value, pool: "pool-a" },
        modelLease: f.pool.value,
        identity: { pool: "pool-a" },
      };
    },
  });
  const answer = await governedResume(input, f.deps);
  assert.equal(answer.status, 410);
  assert.deepEqual([f.device.released(), f.pool.released()], [1, 1]);
});

test("a resume admitted under another pool than its call's is refused and keeps no lease", async (context) => {
  context.mock.method(console, "info", () => {});
  const f = deps({
    admit: async () => ({ modelLease: f.pool.value, identity: { pool: "pool-b" } }),
  });
  const answer = await governedResume(input, f.deps);
  assert.equal(answer.status, 410);
  assert.equal(f.pool.released(), 1);
});

test("a resume whose serve fails keeps no lease", async () => {
  const f = deps({
    serve: async () => {
      throw new Error("container unreachable");
    },
  });
  await assert.rejects(governedResume(input, f.deps), /container unreachable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([f.device.released(), f.pool.released()], [1, 1]);
});

test("a resume with no call, or one its instance cut, is refused before admission", async (context) => {
  context.mock.method(console, "info", () => {});
  let admitted = 0;
  const counting = { admit: async () => ((admitted += 1), {}) };
  assert.equal(
    (await governedResume({ ...input, call: undefined }, deps(counting).deps)).status,
    410,
  );
  assert.equal(
    (await governedResume(input, deps({ ...counting, cut: () => true }).deps)).status,
    410,
  );
  assert.equal(admitted, 0);
});

const lines = (info: { mock: { calls: { arguments: unknown[] }[] } }, name: string) =>
  info.mock.calls.filter((call) => call.arguments[0] === name).map((call) => call.arguments[1]);

test("an admitted resume writes one line, with its offset and target", async (context) => {
  const info = context.mock.method(console, "info", () => {});
  const answer = await governedResume(input, deps().deps);
  assert.equal(answer.status, 200);
  await answer.text();
  assert.deepEqual(lines(info, "POOL_STREAM_RESUME_ADMITTED"), [
    { requestId, from: 10, target: "primary" },
  ]);
  assert.deepEqual(lines(info, "POOL_STREAM_RESUME_REFUSED"), []);
});

test("each refused resume writes one line with its closed reason", async (context) => {
  const info = context.mock.method(console, "info", () => {});
  let draining = false;
  const cases = [{ ...input, call: undefined }, input, input, input];
  await governedResume(cases[0], deps().deps);
  await governedResume(cases[1], deps({ cut: () => true }).deps);
  await governedResume(
    cases[2],
    deps({
      admit: async () => {
        throw new Error("revoked");
      },
    }).deps,
  );
  await governedResume(
    cases[3],
    deps({
      draining: () => draining,
      admit: async () => {
        draining = true;
        return { identity: { pool: "pool-a" } };
      },
    }).deps,
  );
  assert.deepEqual(
    lines(info, "POOL_STREAM_RESUME_REFUSED").map(
      (fields) => (fields as { reason: string }).reason,
    ),
    ["no_call", "cut", "refused", "handover"],
  );
  assert.deepEqual(lines(info, "POOL_STREAM_RESUME_ADMITTED"), []);
});
