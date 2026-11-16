import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeStageRecord } from "./runtime-slots/staging.ts";

const read = async (response: Response) =>
  Schema.decodeUnknownSync(Schema.Struct({ result: RuntimeStageRecord }))(await response.json())
    .result;

test("reconstruction observes the original startup deadline and expires without another launch", async (context) => {
  const f = await handoffWorker();
  const entered = deferred(),
    release = deferred();
  f.candidate.hooks.health = async () => {
    entered.resolve();
    await release.promise;
  };
  context.after(async () => {
    release.resolve();
    await f.cleanup();
  });
  const grant = await f.startGrant();
  const accepted = await read(await f.command("stage", { proof: grant.envelope }));
  assert.equal(accepted.status, "starting");
  await entered.promise;
  assert.equal(f.candidate.calls.start, 1);
  f.reconstruct();
  context.mock.method(Date, "now", () => accepted.deadline);
  const expired = await read(await f.command("stage-inspect", { target: grant.proof.target }));
  assert.equal(expired.status, "failed");
  assert.equal(expired.deadline, accepted.deadline);
  assert.equal(expired.operationId, accepted.operationId);
  assert.equal(f.candidate.calls.start, 1);
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 409);
  context.mock.restoreAll();
  release.resolve();
  await f.old.storage.when(`runtime-slots-v1:startup:${grant.proof.target.slotId}`, (value) =>
    Schema.is(Schema.Struct({ status: Schema.Literal("failed") }))(value),
  );
  assert.equal((await f.inspect()).selection.active.identity?.bootId, f.old.identity().bootId);
});
