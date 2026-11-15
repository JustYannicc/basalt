import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { StartupWitness } from "./runtime-slots/admission-proof.ts";
import { StartupAbortIntent, StartupAbortReceipt } from "./runtime-slots/startup-abort-contract.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
const receipt = async (response: Response) =>
  Schema.decodeUnknownSync(Schema.Struct({ result: StartupAbortReceipt }))(await response.json())
    .result;
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";

test("an operator abort settles an unknown candidate start without promoting or destroying the healthy active runtime", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  f.loseStartReply();
  assert.equal((await f.stage(grant.envelope)).status, 409);
  const snapshot = await f.inspect();
  assert.equal(snapshot.selection.candidate?.identity, undefined);
  const witnessReply = await f.command("witness", { target: grant.proof.target });
  const {
    result: { witness },
  } = await witnessReply.json();
  const intent = {
    operationId: "abort-unknown-start",
    target: grant.proof.target,
    expectedEpoch: snapshot.selection.epoch,
    active: snapshot.selection.active.identity!,
    startupOperationId: grant.proof.operationId,
    witness,
  };
  const aborted = await f.command("startup-abort", { intent });
  assert.equal(aborted.status, 200, await aborted.clone().text());
  const receipt = (await aborted.json()).result;
  assert.equal(receipt.status, "aborted");
  assert.deepEqual(receipt.intent, intent);
  assert.equal((await f.inspect()).selection.candidate, undefined);
  assert.equal(f.old.calls.destroy, 0);
  assert.equal(f.candidate.calls.destroy, 1);
  assert.equal(f.candidate.calls.start, 1);
  f.reconstruct();
  assert.deepEqual((await (await f.command("startup-abort", { intent })).json()).result, receipt);
  assert.equal(f.candidate.calls.destroy, 1);
  const stillServing = await f.model();
  assert.equal(stillServing.status, 200);
  assert.equal(stillServing.headers.get("X-Signalbox-Pool-Boot"), f.old.identity().bootId);
  await stillServing.body?.cancel();
});

async function abortIntent(
  f: Awaited<ReturnType<typeof handoffWorker>>,
  proof: Awaited<ReturnType<typeof f.startGrant>>["proof"],
) {
  const snapshot = await f.inspect();
  const reply = await f.command("witness", { target: proof.target });
  const witness = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ witness: Schema.optional(StartupWitness) }) }),
  )(await reply.json()).result.witness;
  return Schema.decodeUnknownSync(StartupAbortIntent)({
    operationId: "operator-abort",
    target: proof.target,
    startupOperationId: proof.operationId,
    expectedEpoch: snapshot.selection.epoch,
    active: snapshot.selection.active.identity!,
    witness: witness ?? null,
  });
}

test("a changed launch witness or active boot cannot authorize candidate destruction", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  assert.equal((await f.stage(grant.envelope)).status, 200);
  const intent = await abortIntent(f, grant.proof);
  assert.ok(intent.witness);
  for (const forged of [
    { ...intent, active: { ...intent.active, bootId: "other-boot" } },
    {
      ...intent,
      witness: {
        ...intent.witness,
        launch: { ...intent.witness.launch, tokenHash: "0".repeat(64) },
      },
    },
  ])
    assert.equal((await f.command("startup-abort", { intent: forged })).status, 409);
  assert.equal(f.candidate.calls.destroy, 0);
  assert.equal(f.old.calls.destroy, 0);
  assert.equal((await f.inspect()).selection.candidate?.fenced, false);
});

test("a lost destroy acknowledgement is recovered without another destruction", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  assert.equal((await f.stage(grant.envelope)).status, 200);
  const intent = await abortIntent(f, grant.proof);
  const destroy = f.candidate.ctx.container.destroy;
  f.candidate.ctx.container.destroy = async () => {
    await destroy();
    throw new Error("synthetic lost destroy acknowledgement");
  };
  const first = await f.command("startup-abort", { intent });
  assert.equal((await receipt(first)).status, "pending");
  assert.equal((await f.inspect()).selection.candidate?.fenced, true);
  assert.equal(f.candidate.calls.destroy, 1);
  f.reconstruct();
  const recovered = await f.command("startup-abort-inspect", { operationId: intent.operationId });
  assert.equal((await receipt(recovered)).status, "aborted");
  assert.equal(f.candidate.calls.destroy, 1);
  assert.equal((await f.inspect()).selection.candidate, undefined);
});

test("unknown provider absence retains the fenced candidate and capacity until positive inspection", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  assert.equal((await f.stage(grant.envelope)).status, 200);
  const intent = await abortIntent(f, grant.proof);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    ).pathname.endsWith(`${f.candidate.target.applicationId}/instances-v2`)
      ? new Response(null, { status: 503 })
      : fetchBefore(input, init);
  try {
    const reply = await f.command("startup-abort", { intent });
    assert.equal((await receipt(reply)).status, "pending");
    assert.equal((await f.inspect()).selection.candidate?.fenced, true);
    assert.equal(f.candidate.calls.destroy, 1);
  } finally {
    globalThis.fetch = fetchBefore;
  }
  f.reconstruct();
  const reply = await f.command("startup-abort-inspect", { operationId: intent.operationId });
  assert.equal((await receipt(reply)).status, "aborted");
  assert.equal(f.candidate.calls.destroy, 1);
});

test("an abort before the physical start fences a late startup continuation without destroying anything", async (context) => {
  const entered = deferred(),
    release = deferred();
  const f = await handoffWorker({
    candidateEndpoint: {
      beforeStart: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  });
  context.after(async () => {
    release.resolve();
    await f.cleanup();
  });
  const grant = await f.startGrant();
  const staged = await f.command("stage", { proof: grant.envelope });
  assert.equal(staged.status, 200);
  await entered.promise;
  assert.equal(f.candidate.calls.start, 0);
  const intent = await abortIntent(f, grant.proof);
  const aborted = await f.command("startup-abort", { intent });
  assert.equal((await receipt(aborted)).status, "aborted");
  release.resolve();
  await f.old.storage.when(`runtime-slots-v1:startup:${grant.proof.target.slotId}`, (value) =>
    Schema.is(Schema.Struct({ status: Schema.Literal("failed") }))(value),
  );
  assert.equal(f.candidate.calls.start, 0);
  assert.equal(f.candidate.calls.destroy, 0);
  assert.equal((await f.inspect()).selection.candidate, undefined);
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 409);
});
