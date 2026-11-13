import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { failureFleetFixture } from "../../scripts/pool-tests/runtime-fleet-failure-fixture.ts";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";

const Phases = Schema.Array(Schema.Struct({ phase: Schema.String }));
function refuseQuarantine(f: Awaited<ReturnType<typeof failureFleetFixture>>) {
  f.memory.beforeCommit = (draft) => {
    if (
      Schema.decodeUnknownSync(Phases)(draft.get("runtime-fleet-v1:resources")).some(
        (row) => row.phase === "quarantined",
      )
    )
      throw new Error("synthetic quarantine write unavailable");
  };
}

test("a rejected quarantine write retains the failed reservation and original dispatched error", async () => {
  const f = await failureFleetFixture(1),
    identity = await f.add(),
    original = new Error("original runtime failure");
  refuseQuarantine(f);
  f.cell(identity).forward = async (_request, _port, _pool, before) => {
    before();
    throw original;
  };
  let caught: unknown;
  try {
    await f.forward();
  } catch (error) {
    caught = error;
  }
  await f.settle();
  assert.equal((await f.state.inspect())[0]?.active, 1);
  assert.equal(caught, original);
  assert.equal((await f.state.inspect())[0]?.phase, "ready");
  assert.equal(f.legacyCalls(), 0);
});

test("a body failure cannot release its unresolved fleet reservation when fencing rejects", async () => {
  const f = await failureFleetFixture(1),
    identity = await f.add(),
    original = new Error("original body failure");
  refuseQuarantine(f);
  let body!: ReadableStreamDefaultController<Uint8Array>;
  f.cell(identity).forward = async (_request, _port, _pool, before) => {
    before();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    );
  };
  const response = await f.forward(),
    reading = response.text();
  body.error(original);
  await assert.rejects(reading, (error) => error === original);
  await f.settle();
  assert.equal((await f.state.inspect())[0]?.active, 1);
  assert.equal((await f.state.inspect())[0]?.phase, "ready");
});

test("client cancellation cannot release a body failure while quarantine is unresolved", async (context) => {
  const f = await failureFleetFixture(1),
    identity = await f.add();
  const entered = deferred(),
    fence = deferred();
  context.mock.method(f.state, "quarantine", async () => {
    entered.resolve();
    await fence.promise;
  });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  f.cell(identity).forward = async (_request, _port, _pool, before) => {
    before();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
        },
      }),
    );
  };
  const response = await f.forward(),
    reader = response.body!.getReader();
  const reading = reader.read();
  const original = new Error("synthetic body failure");
  body.error(original);
  await entered.promise;
  await assert.rejects(reader.cancel(), (error) => error === original);
  await reading;
  await f.settle();
  assert.equal((await f.state.inspect())[0]?.active, 1);
  fence.reject(new Error("synthetic quarantine write unavailable"));
  await f.settle();
});
