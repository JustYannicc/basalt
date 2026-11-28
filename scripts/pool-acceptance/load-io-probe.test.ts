import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import test from "node:test";
import { acceptanceCredential } from "../release/acceptance-device.ts";
import { ioLagLimitMs } from "./load-classes.ts";
import { startIoProbe } from "./load-io-probe.ts";
import { parseLoadShape } from "./load-shape.ts";
import { runLoad } from "./load.ts";
import { deviceEnv, frame, pacedPool, testClock } from "./test/load-fixtures.ts";

const busy = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until);
};

/** Runs `onData` inside a socket callback, the same phase the pool's answers are read in. */
async function inSocketCallback(onData: () => void) {
  const server = createServer((socket) => socket.once("data", () => onData()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const client = createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve) => client.once("connect", resolve));
  client.write("x");
  return async () => {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

test("two blocks with no socket poll between them are measured as one wait", async () => {
  // Each block is under the limit. Between a socket callback and the check phase right after it, or
  // between two timers due together, the loop polls no socket, so an answer that arrived during the
  // first block waits through both.
  const shapes: Record<string, (done: () => void) => void> = {
    "socket callback, then the check phase": (done) => {
      busy(1_600);
      setImmediate(() => {
        busy(1_600);
        done();
      });
    },
    "two timers due together": (done) => {
      setTimeout(() => busy(1_600), 30);
      setTimeout(() => {
        busy(1_600);
        done();
      }, 30);
    },
  };
  for (const [shape, blocks] of Object.entries(shapes)) {
    const probe = await startIoProbe();
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const close = await inSocketCallback(() => blocks(done));
    await finished;
    const lag = await probe.stop();
    await close();
    assert.ok((lag ?? 0) >= 3_200, `${shape}: ${lag}`);
  }
});

test("two blocks with a socket poll between them that reads the probe's byte first are measured as one wait", async () => {
  // A6: block 1 runs in the check phase right after a probe read, so the next byte is written and
  // read only after it. Block 2 runs in that next poll, right after the probe's own read callback
  // (a nextTick from inside it), where another socket's callback would hold an answer back. That
  // answer waited through both, from the write before block 1 to the read after block 2.
  let reads = 0;
  let armed = false;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const fromRead = () => new Error().stack?.includes("received") === true;
  const probe = await startIoProbe(() => {
    const at = performance.now();
    if (armed && fromRead()) {
      reads += 1;
      if (reads === 1) setImmediate(() => busy(1_600));
      if (reads === 2)
        process.nextTick(() => {
          busy(1_600);
          done();
        });
    }
    return at;
  });
  armed = true;
  await finished;
  const lag = await probe.stop();
  assert.ok((lag ?? 0) >= 3_200, String(lag));
});

test("a block that starts when no probe byte is waiting is still measured", async () => {
  // The probe resolves right after a poll read its first byte; the check phase that follows runs
  // before the next write, so nothing of the probe is out when this block starts.
  const probe = await startIoProbe();
  await new Promise<void>((resolve) =>
    setImmediate(() => {
      busy(ioLagLimitMs + 100);
      resolve();
    }),
  );
  const lag = await probe.stop();
  assert.ok((lag ?? 0) >= ioLagLimitMs + 100, String(lag));
});

test("a healthy run at the highest concurrency keeps its wait far under the limit", async () => {
  const clock = testClock();
  const chat = {
    role: { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
    content: { choices: [{ delta: { content: "OK" }, finish_reason: null }] },
    stop: { choices: [{ delta: {}, finish_reason: "stop" }] },
    usage: { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } },
  };
  const answer = [chat.role, chat.content, chat.stop, chat.usage, "[DONE]"].map(frame).join("");
  const pool = pacedPool(clock, [[0, answer]]);
  const shape = parseLoadShape(
    JSON.stringify({
      concurrency: 500,
      durationMinutes: 1,
      calls: 5_000,
      mix: [{ shape: "chat", weight: 1 }],
    }),
  );
  const run = await runLoad({
    client: pool.client,
    credential: acceptanceCredential(deviceEnv),
    shape,
    clock,
    witness: pool.witness,
  });
  assert.equal(run.calls.length, 5_000);
  assert.equal(run.verdict.passes, 5_000);
  assert.ok((run.verdict.ioLagMaxMs ?? Infinity) < 1_000, String(run.verdict.ioLagMaxMs));
  assert.equal(run.verdict.passed, true);
});
