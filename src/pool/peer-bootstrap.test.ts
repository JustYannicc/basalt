import assert from "node:assert/strict";
import { test } from "node:test";
import bundle from "./home-peer-program.json" with { type: "json" };
import { PeerBootstrap } from "./runtime-slots/peer-bootstrap.ts";
import type { PeerBootstrapInput } from "./runtime-slots/peer-bootstrap.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";

function fixture() {
  const storage = new RuntimeSqlite();
  const input: PeerBootstrapInput = {
    operationId: "bootstrap-one",
    configurationFingerprint: "f".repeat(64),
    sourceSha: bundle.sourceSha,
    identity: {
      format: "pool-runtime-slot-v1",
      controllerId: "controller",
      slotId: "legacy",
      applicationId: "legacy",
      applicationVersion: "1",
      instanceId: "controller",
      bootId: "legacy-boot",
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageInput: "old-image",
    },
  };
  let witness:
    | {
        nonce: string;
        sourceSha: string;
        bootId: string;
        pid: number;
        startTicks: string;
        ready: boolean;
      }
    | undefined;
  let starts = 0;
  let alive = true;
  let lost = false;
  let healthy = true;
  const ctx = {
    id: { toString: () => "controller" },
    storage,
    waitUntil: () => {},
    container: {
      running: true,
      start: () => {},
      destroy: async () => {},
      setInactivityTimeout: async () => {},
      getTcpPort: () => ({ fetch: async () => new Response(null) }),
      exec: async (command: string[], options?: { stdout: "pipe"; stderr: "ignore" }) => {
        assert.deepEqual(command.slice(0, 2), ["python3", "-c"]);
        if (command.length === 4) {
          assert.equal(command[2], bundle.program);
          assert.deepEqual(options, { stdout: "pipe", stderr: "ignore" });
          starts++;
          witness = { ...JSON.parse(command[3]!), pid: 7, startTicks: "12345", ready: true };
          if (lost) throw new Error("lost exec response");
          return {
            pid: 40001,
            stdout: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(JSON.stringify(witness) + "\n"));
                controller.close();
              },
            }),
            output: async () => {
              throw new Error("long helper output must not be collected");
            },
          };
        }
        assert.equal(command.length, 3);
        assert.equal(options, undefined);
        return {
          output: async () => ({
            exitCode: 0,
            stdout: new TextEncoder().encode(
              JSON.stringify({ live: alive && !!witness, ...(witness ? { witness } : {}) }),
            ),
            stderr: new Uint8Array(),
          }),
        };
      },
    },
  };
  const service = () =>
    new PeerBootstrap(ctx, async () => {
      if (!healthy) throw new Error("boot changed");
    });
  return {
    input,
    storage,
    service,
    get starts() {
      return starts;
    },
    loseExecReply: () => {
      lost = true;
    },
    loseHelper: () => {
      alive = false;
    },
    changeBoot: () => {
      healthy = false;
    },
    cleanup: () => storage.close(),
  };
}

test("legacy helper starts once from fixed bundled bytes and survives controller reconstruction", async (context) => {
  const f = fixture();
  context.after(f.cleanup);
  const result = await f.service().run(f.input, AbortSignal.timeout(2_000));
  assert.equal(result.observation, "ready");
  assert.equal(result.hostPid, 40001);
  assert.ok("witness" in result && result.witness.pid === 7);
  assert.equal(f.starts, 1);
  assert.equal((await f.service().run(f.input, AbortSignal.timeout(2_000))).observation, "ready");
  assert.equal(f.starts, 1);
  await assert.rejects(
    f.service().run({ ...f.input, operationId: "different" }, AbortSignal.timeout(2_000)),
    /identity/,
  );
  assert.equal(f.starts, 1);
});

test("an ambiguous exec is recovered through a fresh witness read without another exec start", async (context) => {
  const f = fixture();
  context.after(f.cleanup);
  f.loseExecReply();
  assert.equal((await f.service().run(f.input, AbortSignal.timeout(2_000))).observation, "ready");
  assert.equal((await f.service().run(f.input, AbortSignal.timeout(2_000))).observation, "ready");
  assert.equal(f.starts, 1);
});

test("losing the durable intent acknowledgement never authorizes a retry start", async (context) => {
  const f = fixture();
  context.after(f.cleanup);
  f.storage.afterCommit = () => {
    throw new Error("lost durable intent reply");
  };
  await assert.rejects(f.service().run(f.input, AbortSignal.timeout(2_000)), /lost durable intent/);
  assert.equal(f.starts, 0);
  f.storage.afterCommit = () => {};
  assert.equal((await f.service().run(f.input, AbortSignal.timeout(2_000))).observation, "unknown");
  assert.equal(f.starts, 0);
});

test("a dead or reused helper process is unknown and cannot be silently restarted", async (context) => {
  const f = fixture();
  context.after(f.cleanup);
  assert.equal((await f.service().run(f.input, AbortSignal.timeout(2_000))).observation, "ready");
  f.loseHelper();
  assert.equal((await f.service().run(f.input, AbortSignal.timeout(2_000))).observation, "unknown");
  assert.equal(f.starts, 1);
});

test("a changed boot prevents helper activation or another start", async (context) => {
  const f = fixture();
  context.after(f.cleanup);
  await f.service().run(f.input, AbortSignal.timeout(2_000));
  f.changeBoot();
  await assert.rejects(f.service().run(f.input, AbortSignal.timeout(2_000)), /boot changed/);
  assert.equal(f.starts, 1);
});
