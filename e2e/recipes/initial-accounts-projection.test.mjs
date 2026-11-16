import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { holdInitialAccountsProjection } from "./initial-accounts-projection.mjs";

test("Accounts readiness joins competing initial projection reads", async () => {
  const iterations = Number(process.env.BASALT_READINESS_ITERATIONS ?? 20);
  assert.ok(Number.isInteger(iterations) && iterations > 0 && iterations <= 1_000);
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const workers = Array.from(
    { length: process.env.BASALT_READINESS_LOAD === "1" ? 2 : 0 },
    () =>
      new Worker(
        'const {workerData,parentPort}=require("node:worker_threads"); const stop=new Int32Array(workerData); parentPort.postMessage("busy"); while(!Atomics.load(stop,0)) { Math.sqrt(Math.random()); }',
        { eval: true, workerData: stop.buffer },
      ),
  );
  let failures = 0;
  let firstFailure;
  try {
    await Promise.all(
      workers.map((worker) => new Promise((resolve) => worker.once("message", resolve))),
    );
    for (let iteration = 0; iteration < iterations; iteration++) {
      const sent = [];
      const browser = {
        URL,
        Request,
        location: new URL("https://routes-fixture.invalid"),
        fetch: async (input) => {
          sent.push(String(input));
          return new Response("[]", { status: 200 });
        },
      };
      browser.window = browser;
      const context = {
        async exposeFunction(name, call) {
          browser[name] = call;
        },
        async addInitScript(script, arg) {
          runInNewContext(
            typeof script === "function" ? `(${script})(${JSON.stringify(arg)})` : script.content,
            browser,
          );
        },
      };
      const hold = await holdInitialAccountsProjection(context, () =>
        context.addInitScript(() => {
          const original = window.fetch;
          window.project = () => original("/api/organizations/synthetic/resources/accounts");
        }),
      );
      // The second response is eligible to satisfy the caller's any-success response join.
      const first = browser.project();
      const competing = browser.project();
      const other = browser.fetch("/api/organizations/synthetic/resources/apps");
      try {
        await other;
        await hold.verifyJoin(
          { clock: { runFor: () => new Promise(setImmediate) } },
          () => Promise.race([first, competing]),
          { isVisible: async () => true },
          { isVisible: async () => false },
        );
        hold.assertJoined();
        assert.equal(sent.filter((url) => url.endsWith("/accounts")).length, 2);
        assert.equal(sent.filter((url) => url.endsWith("/apps")).length, 1);
        await browser.project();
        assert.equal(sent.filter((url) => url.endsWith("/accounts")).length, 3);
      } catch (error) {
        failures++;
        firstFailure ??= error;
      } finally {
        hold.release();
        await Promise.all([first, competing]);
      }
    }
  } finally {
    Atomics.store(stop, 0, 1);
    await Promise.all(
      workers.map((worker) => new Promise((resolve) => worker.once("exit", resolve))),
    );
  }
  console.log(JSON.stringify({ iterations, failures, loadWorkers: workers.length }));
  if (firstFailure) throw firstFailure;
});
