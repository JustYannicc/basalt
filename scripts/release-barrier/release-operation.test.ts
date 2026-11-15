import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReleaseOperationError,
  releaseOperationFingerprint,
  runPlannedReleaseOperation,
  type PlannedReleaseOperation,
  type ReleaseOperationReceipt,
} from "./release-operation.ts";

const candidate = "a".repeat(40);
type Intent = { worker: string; revision: number };
type Result = { activated: boolean };
const intent: Intent = { worker: "fixture-worker", revision: 1 };
const result: Result = { activated: true };
const fingerprint = releaseOperationFingerprint(candidate, intent);
type Receipt = ReleaseOperationReceipt<Intent, Result>;

function fixture(overrides: Partial<PlannedReleaseOperation<Intent, Result>> = {}) {
  const calls: string[] = [];
  const saved: Receipt[] = [];
  const options: PlannedReleaseOperation<Intent, Result> = {
    candidate,
    mode: fingerprint,
    plan: async () => {
      calls.push("plan");
      return intent;
    },
    execute: async () => {
      calls.push("execute");
      return result;
    },
    inspect: async () => {
      calls.push("inspect");
      return { status: "pending" };
    },
    save: async (receipt) => {
      calls.push(`save-${receipt.status}`);
      saved.push(receipt);
    },
    ...overrides,
  };
  return { options, calls, saved, run: () => runPlannedReleaseOperation(options) };
}

function pending(): Receipt {
  return { candidate, fingerprint, intent, status: "pending", sent: true };
}

test("plan binds candidate and canonical material intent without saving or sending", async () => {
  const f = fixture({ mode: "plan" });
  assert.deepEqual(await f.run(), { candidate, fingerprint, intent, status: "pending" });
  assert.deepEqual(f.calls, ["plan"]);
  assert.equal(
    releaseOperationFingerprint(candidate, { revision: 1, worker: "fixture-worker" }),
    fingerprint,
  );
  assert.notEqual(releaseOperationFingerprint("b".repeat(40), intent), fingerprint);
});

test("matching digest durably records pending before exactly one business operation", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { ...pending(), status: "complete", result });
  assert.deepEqual(f.calls, ["plan", "save-pending", "execute", "save-complete"]);
  assert.deepEqual(f.saved[0], pending());
});

test("changed material input refuses the approved digest before any save or execute", async () => {
  const f = fixture({ plan: async () => ({ ...intent, revision: 2 }) });
  await assert.rejects(f.run, { message: "release-operation-plan-stale" });
  assert.deepEqual(f.saved, []);
  assert.deepEqual(f.calls, []);
});

test("a prior unsent plan is rechecked before sending and cannot hide changed state", async () => {
  const f = fixture({
    existing: { candidate, fingerprint, intent, status: "pending" },
    plan: async () => ({ ...intent, revision: 2 }),
  });
  await assert.rejects(f.run, { message: "release-operation-plan-stale" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.saved, []);
});

test("wrong candidate and a tampered receipt refuse before callbacks", async () => {
  for (const existing of [
    { ...pending(), candidate: "b".repeat(40) },
    { ...pending(), intent: { ...intent, revision: 2 } },
  ]) {
    const f = fixture({ existing });
    await assert.rejects(f.run, ReleaseOperationError);
    assert.deepEqual(f.calls, []);
  }
});

test("invalid candidate, mode and noncanonical intent use closed errors", async () => {
  for (const options of [{ candidate: "bad" }, { mode: "apply" }]) {
    const f = fixture(options);
    await assert.rejects(f.run, ReleaseOperationError);
    assert.deepEqual(f.calls, []);
  }
  assert.throws(() => releaseOperationFingerprint(candidate, { private: Symbol("secret") }), {
    message: "release-operation-intent-invalid",
  });
});

test("a lost execute reply can be settled by inspection without another send", async () => {
  let writes = 0;
  const f = fixture({
    execute: async () => {
      writes++;
      throw new Error("private lost reply");
    },
    inspect: async () => ({ status: "complete", result }),
  });
  const completed = await f.run();
  assert.equal(writes, 1);
  assert.deepEqual(completed, { ...pending(), status: "complete", result });
  assert.deepEqual(
    f.saved.map((receipt) => receipt.status),
    ["pending", "complete"],
  );
  const retry = fixture({ existing: completed });
  assert.deepEqual(await retry.run(), completed);
  assert.deepEqual(retry.calls, []);
});

test("unknown execution and inspection retain durable pending across fresh callers", async () => {
  let writes = 0;
  const execute = async () => {
    writes++;
    throw new Error("private failure");
  };
  const inspect = async (): Promise<never> => {
    throw new Error("private inspection failure");
  };
  const first = fixture({ execute, inspect });
  assert.deepEqual(await first.run(), pending());
  assert.equal(first.saved.length, 1);
  const retry = fixture({ existing: first.saved[0], execute, inspect });
  assert.deepEqual(await retry.run(), pending());
  assert.equal(writes, 1);
  assert.deepEqual(retry.saved, []);
});

test("an existing sent digest inspects the original intent without replanning or sending", async () => {
  const f = fixture({
    existing: pending(),
    inspect: async () => ({ status: "complete", result }),
  });
  assert.deepEqual(await f.run(), { ...pending(), status: "complete", result });
  assert.deepEqual(f.calls, ["save-complete"]);
});

test("existing plans preserve the frozen receipt without callback or intent reset", async () => {
  const f = fixture({ mode: "plan", existing: pending() });
  assert.deepEqual(await f.run(), pending());
  assert.deepEqual(f.calls, []);
});

test("inspect is read-only for an existing pending receipt and for an unsent plan", async () => {
  for (const existing of [undefined, pending()]) {
    const f = fixture({
      mode: "inspect",
      existing,
      inspect: async () => ({ status: "complete", result }),
    });
    const observed = await f.run();
    assert.equal(observed.status, "complete");
    assert.equal(observed.sent, existing?.sent);
    assert.deepEqual(f.calls, existing ? [] : ["plan"]);
    assert.deepEqual(f.saved, []);
  }
});

test("a stale digest cannot inspect or save an existing operation", async () => {
  const f = fixture({ mode: "f".repeat(64), existing: pending() });
  await assert.rejects(f.run, { message: "release-operation-plan-stale" });
  assert.deepEqual(f.calls, []);
});

test("failed pending save cannot execute and does not expose callback errors", async () => {
  const f = fixture({
    save: async () => {
      throw new Error("private database URL");
    },
  });
  await assert.rejects(f.run, { message: "release-operation-save-failed" });
  assert.deepEqual(f.calls, ["plan"]);
});

test("failed completion save leaves an inspectable send rather than authorizing another execution", async () => {
  const f = fixture();
  f.options.save = async (receipt) => {
    if (receipt.status === "complete") throw new Error("private persistence failure");
    f.saved.push(receipt);
  };
  await assert.rejects(f.run, { message: "release-operation-save-failed" });
  const retry = fixture({
    existing: f.saved[0],
    inspect: async () => ({ status: "complete", result }),
  });
  assert.equal((await retry.run()).status, "complete");
  assert.deepEqual(retry.calls, ["save-complete"]);
});

test("planning failures expose only the closed failure code", async () => {
  const f = fixture({
    plan: async () => {
      throw new Error("private provider response");
    },
  });
  await assert.rejects(f.run, { message: "release-operation-plan-failed" });
  assert.deepEqual(f.saved, []);
});

test("callbacks cannot mutate the frozen journal intent", async () => {
  const f = fixture({
    execute: async (value) => {
      value.revision = 99;
      return result;
    },
  });
  const completed = await f.run();
  assert.equal(completed.intent.revision, 1);
  assert.equal(f.saved[0]!.intent.revision, 1);
  assert.equal(completed.fingerprint, fingerprint);
});
