import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationFailure } from "../../scripts/production-ops/failure.ts";
import { fixture, selection } from "../../scripts/production-ops/import-removal-fixture.ts";

test("import removal finishes readiness before creating each DELETE deadline", async () => {
  const f = fixture();
  const dry = await f.invoke();
  const result = await f.invoke("migrate", f.approve(dry));
  assert.equal(result.action, "apply");
  assert.equal(f.calls.length, 8);
});

test("cold readiness can exceed the DELETE budget without issuing a late or cancelled DELETE", async (t) => {
  const f = fixture();
  const dry = await f.invoke();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setReady(async () => {
    entered();
    await held;
  });
  f.setHome(async (path, init) => {
    assert.equal(init.signal?.aborted, false);
    return f.performHome(path, init);
  });
  const applying = f.invoke("migrate", f.approve(dry));
  await started;
  t.mock.timers.tick(10_001);
  assert.equal(f.calls.length, 0);
  release();
  await applying;
  assert.equal(f.calls.length, 8);
});

test("readiness failures preserve their phase and never send a DELETE", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setReady(async () => {
    throw new DOMException("private-health-response", "TimeoutError");
  });
  await assert.rejects(f.invoke("migrate", f.approve(dry)), (error: unknown) => {
    assert.ok(error instanceof OperationFailure);
    assert.equal(error.receipt.phase, "readiness");
    assert.equal(error.receipt.code, "deadline_exceeded");
    assert.equal(error.receipt.httpStatus, 504);
    assert.ok(!JSON.stringify(error).includes("private-health-response"));
    return true;
  });
  assert.equal(f.calls.length, 0);
  const inventory = f.decrypt(
    (await f.invoke("inventory", { planSha256: f.approve(dry).planSha256 })).artifact,
  );
  assert.equal(inventory.receipt.status, "incomplete");
  assert.equal(inventory.receipt.failure.phase, "readiness");
  assert.equal(inventory.receipt.pending, undefined);
});

test("a token refresh during readiness invalidates the reviewed snapshot before DELETE", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setReady(async () => {
    f.state.credentials[0]!.row += " ";
  });
  await assert.rejects(
    f.invoke("migrate", f.approve(dry)),
    (error: unknown) =>
      error instanceof OperationFailure && error.receipt.code === "snapshot_changed",
  );
  assert.equal(f.calls.length, 0);
});

test("an aborted DELETE stays pending and cannot issue a late port request", async (t) => {
  const f = fixture();
  const dry = await f.invoke();
  const controller = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
    assert.ok(milliseconds === 290_000 || milliseconds === 10_000);
    return milliseconds === 10_000 ? controller.signal : new AbortController().signal;
  });
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setHome(async (path, init) => {
    entered();
    await held;
    init.signal?.throwIfAborted();
    return f.performHome(path, init);
  });
  const applying = f.invoke("migrate", f.approve(dry));
  await started;
  controller.abort(new DOMException("private-timeout-detail", "TimeoutError"));
  await assert.rejects(
    applying,
    (error: unknown) =>
      error instanceof OperationFailure &&
      error.receipt.phase === "credential-delete" &&
      error.receipt.code === "deadline_exceeded",
  );
  release();
  const inventory = f.decrypt(
    (await f.invoke("inventory", { planSha256: f.approve(dry).planSha256 })).artifact,
  );
  assert.equal(inventory.receipt.pending.id, selection.remove[0]!.id);
  assert.equal(f.calls.length, 0);
});

test("unknown Home responses retain status and omit arbitrary error codes or body data", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setHome(async () =>
    Response.json(
      { error: "secret-provider-token", message: "secret-provider-response" },
      { status: 418 },
    ),
  );
  await assert.rejects(f.invoke("migrate", f.approve(dry)), (error: unknown) => {
    assert.ok(error instanceof OperationFailure);
    assert.equal(error.receipt.homeStatus, 418);
    assert.equal(error.receipt.homeCode, undefined);
    assert.ok(!JSON.stringify(error).includes("secret-provider"));
    return true;
  });
});

test("import removal retains the real Home status and closed error code without its response", async () => {
  const f = fixture();
  const dry = await f.invoke();
  f.setHome(async () =>
    Response.json({ error: "write_failed", message: "secret-provider-response" }, { status: 500 }),
  );
  await assert.rejects(f.invoke("migrate", f.approve(dry)), (error: unknown) => {
    assert.ok(error instanceof OperationFailure);
    assert.equal(error.receipt.phase, "credential-delete");
    assert.equal(error.receipt.homeStatus, 500);
    assert.equal(error.receipt.homeCode, "write_failed");
    assert.ok(!JSON.stringify(error.receipt).includes("secret-provider-response"));
    return true;
  });
});
