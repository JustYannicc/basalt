import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import type { PromotionReceipt } from "./runtime-slots/contract.ts";
import { nativeMembershipKey, slotSelectionKey } from "./runtime-slots/storage.ts";

async function successfulView(f: Awaited<ReturnType<typeof handoffWorker>>, fresh: boolean) {
  const { response, body } = await f.view(fresh);
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(!("error" in body), JSON.stringify(body));
  assert.ok(body.accounts.some((account) => account.id === "auth-a"));
}

test("real Worker and SQLite preserve first-attempt fresh and snapshot reads during candidate start, then switch every path", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  await successfulView(f, true);
  await successfulView(f, false);
  assert.deepEqual(await f.worker.availabilityProbe(f.claims.pool), { ok: true, failures: [] });
  const initialModel = await f.model();
  assert.equal(initialModel.headers.get("X-Signalbox-Pool-Boot"), f.old.identity().bootId);
  await initialModel.body?.cancel();
  const entered = deferred(),
    release = deferred();
  let held = false;
  f.candidate.hooks.health = async () => {
    if (!held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
  };
  const grant = await f.startGrant();
  const staging = f.command("stage", { proof: grant.envelope });
  try {
    await entered.promise;
    await successfulView(f, true);
    await successfulView(f, false);
    const during = await f.model();
    assert.equal(during.headers.get("X-Signalbox-Pool-Boot"), f.old.identity().bootId);
    await during.body?.cancel();
    assert.equal(f.candidate.calls.start, 1);
    assert.equal(f.candidate.calls.home, 0);
    assert.equal(f.old.calls.start, 0);
    assert.equal(f.old.calls.destroy, 0);
  } finally {
    release.resolve();
  }
  const staged = await staging;
  assert.equal(staged.status, 200, await staged.clone().text());
  const joined = await f.joined(grant),
    intent = await f.intent();
  const promoted = await f.command("promote", { proof: joined.envelope, intent });
  assert.equal(promoted.status, 200, await promoted.clone().text());
  assert.equal(((await promoted.json()) as { result: PromotionReceipt }).result.status, "promoted");
  assert.equal((await f.worker.deploymentReady()).bootId, f.candidate.identity().bootId);
  await successfulView(f, true);
  await successfulView(f, false);
  assert.deepEqual(await f.worker.availabilityProbe(f.claims.pool), { ok: true, failures: [] });
  const after = await f.model();
  assert.equal(after.headers.get("X-Signalbox-Pool-Boot"), f.candidate.identity().bootId);
  await after.body?.cancel();
  assert.ok(f.candidate.calls.home > 0 && f.candidate.calls.model > 0);
  assert.ok(
    f.candidate.calls.install.some(
      (policy) => policy.pool === "retired-pool" && policy.dirty && policy.accounts.length === 0,
    ),
  );
  const drained = await f.command("drain", { operationId: crypto.randomUUID() });
  assert.equal(drained.status, 200, await drained.clone().text());
  assert.equal(((await drained.json()) as { result: { status: string } }).result.status, "retired");
  assert.equal(f.old.calls.destroy, 1);
  assert.equal(f.candidate.calls.start, 1);
  assert.equal(f.candidate.calls.destroy, 0);
});

test("a real retired-denial rejection refuses promotion while the selected old runtime keeps serving", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  f.candidate.hooks.install = async (policy) => {
    if (policy.pool === "retired-pool") throw new Error("fixture retired denial rejected");
  };
  const grant = await f.startGrant();
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 409);
  await successfulView(f, true);
  await successfulView(f, false);
  const joined = await f.joined(grant),
    intent = await f.intent();
  const response = await f.command("promote", { proof: joined.envelope, intent });
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { result: PromotionReceipt }).result.status, "refused");
  assert.equal((await f.inspect()).selection.active.identity?.bootId, f.old.identity().bootId);
  await successfulView(f, true);
  assert.equal(f.old.calls.destroy, 0);
  assert.equal(f.candidate.calls.start, 1);
});

test("a lost actual start reply survives controller reconstruction and recovers by observation without a second start", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  f.loseStartReply();
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 409);
  assert.equal(f.candidate.calls.start, 1);
  assert.equal((await f.inspect()).selection.candidate?.identity, undefined);
  f.reconstruct();
  await successfulView(f, true);
  assert.equal((await f.command("observe")).status, 200);
  assert.equal(
    (await f.inspect()).selection.candidate?.identity?.bootId,
    f.candidate.identity().bootId,
  );
  assert.equal(f.candidate.calls.start, 1);
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
});

test("promotion keeps an old response body alive and refuses destruction until that body closes", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  f.old.hooks.model = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("old stream remains open"));
        },
      }),
    );
  const oldResponse = await f.model();
  const grant = await f.startGrant();
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 200);
  const intent = await f.intent(),
    joined = await f.joined(grant);
  assert.equal((await f.command("promote", { proof: joined.envelope, intent })).status, 200);
  assert.equal((await f.command("drain", { operationId: crypto.randomUUID() })).status, 409);
  assert.equal(f.old.calls.destroy, 0);
  const reader = oldResponse.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "old stream remains open");
  const next = await f.model();
  assert.equal(next.headers.get("X-Signalbox-Pool-Boot"), f.candidate.identity().bootId);
  await next.body?.cancel();
  await reader.cancel();
  const operationId = crypto.randomUUID();
  assert.equal((await f.command("drain", { operationId })).status, 200);
  assert.equal((await f.command("drain", { operationId })).status, 200);
  assert.equal(f.old.calls.destroy, 1);
});

test("a real dirty reservation during promotion aborts the old stream and prevents switching even when candidate denial fails", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 200);
  f.old.hooks.model = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
      }),
    );
  const stream = await f.model(),
    reader = stream.body!.getReader();
  assert.equal((await reader.read()).value?.[0], 1);
  const entered = deferred(),
    release = deferred();
  f.candidate.hooks.install = async (policy) => {
    if (policy.pool !== f.claims.pool) return;
    if (policy.dirty) throw new Error("fixture dirty install refused");
    entered.resolve();
    await release.promise;
  };
  const intent = await f.intent(),
    joined = await f.joined(grant);
  const promotion = f.command("promote", { proof: joined.envelope, intent });
  try {
    await entered.promise;
    assert.equal((await f.reserve()).status, 503);
    const memberships =
      await f.old.storage.get<Record<string, { dirty: boolean; revision: number }>>(
        nativeMembershipKey,
      );
    assert.equal(memberships?.[f.claims.pool]?.dirty, true);
    assert.equal(memberships?.[f.claims.pool]?.revision, 2);
    assert.equal((await f.model()).status, 503);
    await assert.rejects(reader.read(), /Connection ended/);
    assert.ok(
      f.old.calls.install.some(
        (policy) => policy.pool === f.claims.pool && policy.revision === 2 && policy.dirty,
      ),
    );
  } finally {
    release.resolve();
  }
  const response = await promotion;
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(((await response.json()) as { result: PromotionReceipt }).result.status, "refused");
  assert.equal((await f.inspect()).selection.active.identity?.bootId, f.old.identity().bootId);
  assert.equal(f.old.calls.destroy, 0);
});

test("a lost SQLite promotion acknowledgement retains its atomic selection and receipt across reconstruction", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  assert.equal((await f.command("stage", { proof: grant.envelope })).status, 200);
  const intent = await f.intent(),
    joined = await f.joined(grant);
  let lost = false;
  f.old.storage.afterCommit = (keys) => {
    if (keys.includes(slotSelectionKey) && keys.some((key) => key.endsWith(intent.operationId))) {
      lost = true;
      f.old.storage.afterCommit = () => {};
      throw new Error("fixture lost committed promotion acknowledgement");
    }
  };
  const response = await f.command("promote", { proof: joined.envelope, intent });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(lost, true);
  const receipt = ((await response.json()) as { result: PromotionReceipt }).result;
  assert.equal(receipt.status, "promoted");
  f.reconstruct();
  const observed = await f.command("receipt", { operationId: intent.operationId });
  assert.equal(observed.status, 200);
  assert.deepEqual(((await observed.json()) as { result: PromotionReceipt }).result, receipt);
  const snapshot = await f.inspect();
  assert.equal(snapshot.selection.epoch, intent.expectedEpoch + 1);
  assert.equal(snapshot.selection.active.identity?.bootId, f.candidate.identity().bootId);
  await successfulView(f, true);
  assert.equal(f.candidate.calls.start, 1);
  assert.equal(f.old.calls.destroy, 0);
});

test("an admitted selection with a missing runtime binding refuses requests without warming the legacy container", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const worker = f.reconstruct(false);
  await assert.rejects(worker.deploymentReady());
  assert.equal((await f.model()).status, 503);
  const view = await f.view();
  assert.equal(view.response.status, 503);
  assert.equal("error" in view.body && view.body.error, "backend_unavailable");
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
  assert.equal(f.candidate.calls.start, 0);
});

test("explicit Worker warming renews the selected boot while read-only availability probes leave its idle timer alone", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const before = f.old.calls.keepAlive;
  assert.deepEqual(await f.worker.availabilityProbe(f.claims.pool), { ok: true, failures: [] });
  assert.equal(f.old.calls.keepAlive, before);
  const response = await f.worker.fetch(new Request("http://pool/__warm"));
  assert.equal(response.status, 204);
  assert.equal(f.old.calls.keepAlive, before + 1);
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
});

test("legacy manual and automatic recovery refuse an admitted runtime instead of inspecting or restarting the raw container", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const before = f.old.calls.health;
  await assert.rejects(
    f.worker.automaticRecoveryObservation(f.claims.pool),
    (error: unknown) => error instanceof Error && "status" in error && error.status === 409,
  );
  const manual = await f.worker.fetch(new Request("http://pool/runtime-recovery"));
  assert.equal(manual.status, 409);
  assert.equal(f.old.calls.health, before);
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
});
