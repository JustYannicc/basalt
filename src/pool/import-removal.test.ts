import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationFailure } from "../../scripts/production-ops/failure.ts";
import { fixture } from "../../scripts/production-ops/import-removal-fixture.ts";

test("recovery reconciles a committed DELETE with a lost acknowledgement and preserves the original receipt", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setHome(async (path, init) => {
    await f.performHome(path, init);
    throw new Error("private-transport-detail");
  });
  await assert.rejects(f.invoke("migrate", f.approve(dry)));
  const hash = f.approve(dry).planSha256;
  const original = await f.storage.get(`import-removal:${hash}`);
  assert.equal(f.calls.length, 1);
  assert.equal(f.state.credentials[0]!.deleted, true);
  f.restart();
  await assert.rejects(f.invoke("migrate", f.approve(dry)));
  const freshNormal = await f.invoke().catch(() => undefined);
  if (freshNormal) await assert.rejects(f.invoke("migrate", f.approve(freshNormal)));
  const prepared = await f.prepare(dry);
  const plan = f.decrypt(prepared.artifact);
  assert.equal(plan.originalPlanSha256, hash);
  assert.equal(prepared.changes, 7);
  assert.equal(plan.projection.credentials[0].deleted, true);
  f.setHome(f.performHome);
  await f.resume(prepared);
  assert.equal(f.calls.length, 8, "The uncertain first DELETE is not sent twice");
  assert.ok(f.state.credentials.every((row) => row.deleted));
  assert.ok(f.state.memberships.every((row) => row.deleted));
  assert.deepEqual(await f.storage.get(`import-removal:${hash}`), original);
  const replay = await f.resume(prepared);
  assert.equal(replay.repeated, true);
  assert.equal(f.calls.length, 8);
});

test("a fresh normal plan cannot bypass an incomplete legacy receipt with zero deletes", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setHome(async () => new Response(null, { status: 503 }));
  await assert.rejects(f.invoke("migrate", f.approve(dry)));
  const fresh = await f.invoke();
  f.setHome(f.performHome);
  await assert.rejects(
    f.invoke("migrate", f.approve(fresh)),
    (error: unknown) =>
      error instanceof OperationFailure && error.receipt.code === "recovery_required",
  );
  assert.equal(f.calls.length, 0);
  await f.resume(await f.prepare(dry));
  assert.equal(f.calls.length, 8);
});

test("recovery binds a freshly reviewed token refresh without reusing the old row hash", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setHome(async () => new Response(null, { status: 503 }));
  await assert.rejects(f.invoke("migrate", f.approve(dry)));
  const credential = f.state.credentials[0]!;
  credential.row = JSON.stringify({
    ...JSON.parse(credential.row),
    last_refreshed_at: "2099-01-01T00:00:00Z",
    version: 3,
  });
  const prepared = await f.prepare(dry);
  const before = f.decrypt(dry.artifact).projection.credentials[0].sha256;
  const reviewed = f.decrypt(prepared.artifact).projection.credentials[0].sha256;
  assert.notEqual(reviewed, before);
  f.setHome(f.performHome);
  await f.resume(prepared);
  assert.equal(f.calls.length, 8);
});

test("a lost acknowledgement on a membership or the final DELETE is reconciled without repeating it", async () => {
  for (const failAt of [5, 8]) {
    const f = fixture();
    const dry = await f.invoke();
    f.setHome(async (path, init) => {
      const response = await f.performHome(path, init);
      if (f.calls.length === failAt) throw new Error("Synthetic lost acknowledgement");
      return response;
    });
    await assert.rejects(f.invoke("migrate", f.approve(dry)));
    assert.equal(f.calls.length, failAt);
    const prepared = await f.prepare(dry);
    assert.equal(prepared.changes, 8 - failAt);
    f.setHome(f.performHome);
    await f.resume(prepared);
    assert.equal(f.calls.length, 8);
  }
});

test("a crash after a durable started receipt can be recovered through fresh review", async () => {
  const f = fixture();
  const dry = await f.invoke();
  const hash = f.approve(dry).planSha256;
  await f.storage.put(`import-removal:${hash}`, {
    status: "started",
    planSha256: hash,
    retainSha256: f.state.retain.sha256,
    removed: [],
    memberships: [],
  });
  const original = await f.storage.get(`import-removal:${hash}`);
  await assert.rejects(f.invoke("migrate", f.approve(dry)));
  await f.resume(await f.prepare(dry));
  assert.equal(f.calls.length, 8);
  assert.deepEqual(await f.storage.get(`import-removal:${hash}`), original);
});

test("a failed recovery requires a newly reviewed linked plan and does not clear prior progress", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setHome(async () => new Response(null, { status: 503 }));
  await assert.rejects(f.invoke("migrate", f.approve(dry)));
  const first = await f.prepare(dry);
  f.setHome(async (path, init) => {
    await f.performHome(path, init);
    throw new Error("lost acknowledgement");
  });
  await assert.rejects(f.resume(first));
  f.restart();
  await assert.rejects(f.resume(first));
  const progress = await f.storage.get(`import-removal:${f.approve(first).planSha256}`);
  const next = await f.prepare(dry);
  assert.equal(f.decrypt(next.artifact).priorRecovery.planSha256, f.approve(first).planSha256);
  f.setHome(f.performHome);
  await f.resume(next);
  assert.equal(f.calls.length, 8);
  assert.deepEqual(await f.storage.get(`import-removal:${f.approve(first).planSha256}`), progress);
});

test("recovery refuses changed original receipt, retained checksum, extra membership and row drift", async () => {
  for (const change of ["receipt", "retain", "membership", "row"] as const) {
    const f = fixture();
    const dry = await f.invoke();
    f.setHome(async () => new Response(null, { status: 503 }));
    await assert.rejects(f.invoke("migrate", f.approve(dry)));
    const prepared = await f.prepare(dry);
    if (change === "receipt") {
      const key = `import-removal:${f.approve(dry).planSha256}`;
      await f.storage.put(key, {
        ...f.decrypt(
          (await f.invoke("inventory", { planSha256: f.approve(dry).planSha256 })).artifact,
        ).receipt,
        changed: true,
      });
    } else if (change === "retain") f.state.retain.sha256 = "b".repeat(64);
    else if (change === "membership")
      f.state.memberships.push({ ...f.state.memberships[0]!, id: "9" });
    else f.state.credentials[0]!.row += " ";
    f.setHome(f.performHome);
    await assert.rejects(f.resume(prepared));
    assert.equal(f.calls.length, 0, change);
    if (change === "retain" || change === "membership") await assert.rejects(f.prepare(dry));
  }
});

test("recovery refuses the wrong source, changed deployment and expired approval before deletion", async () => {
  for (const change of ["source", "release", "database", "expiry"] as const) {
    const f = fixture();
    const dry = await f.invoke();
    f.setHome(async () => new Response(null, { status: 503 }));
    await assert.rejects(f.invoke("migrate", f.approve(dry)));
    if (change === "source") {
      await assert.rejects(
        f.invoke("prepare", {
          selection: "home-agent-import-recovery-v1",
          previous: dry,
          planSha256: "b".repeat(64),
        }),
      );
      continue;
    }
    const prepared = await f.prepare(dry);
    if (change === "release") f.deps.release = "changed-release";
    if (change === "database") f.deps.databaseOrigin = "changed-database";
    if (change === "expiry") f.deps.now = () => Date.now() + 3_600_001;
    await assert.rejects(f.resume(prepared));
    assert.equal(f.calls.length, 0);
  }
});
