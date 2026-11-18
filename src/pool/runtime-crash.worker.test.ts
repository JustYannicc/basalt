import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { runtimeRecoveryBudgetMs } from "./runtime-slots/recovery.ts";
import { crashAuditKey, crashNonceKey } from "./runtime-crash-contract.ts";

async function ready(context: { after(fn: () => Promise<void>): void }) {
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "crash-proof-fleet",
    configuration: { ...f.configuration, targetActive: 100 },
  });
  const response = await f.model();
  assert.equal(response.status, 200);
  await response.body?.cancel();
  await f.settle();
  const [sibling] = await f.resourcesWhen((rows) => rows.some((row) => row.phase === "ready"));
  assert.ok(sibling?.identity);
  const at = Date.now();
  const command = {
    identity: f.old.identity(),
    nonce: crypto.randomUUID(),
    operator: "fixture-operator",
    at,
    expiresAt: at + 30_000,
  };
  return { f, command, sibling };
}

test(
  "operator crash refuses a mismatched boot or instance without consuming the nonce",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    for (const identity of [
      { ...command.identity, bootId: "old-boot" },
      { ...command.identity, instanceId: "b".repeat(64) },
    ]) {
      assert.equal((await f.command("runtime-crash", { ...command, identity })).status, 409);
    }
    assert.deepEqual(f.old.calls.signals, []);
    assert.equal(await f.old.storage.get(crashNonceKey(command.nonce)), undefined);
  },
);

test(
  "operator crash refuses expired and overlong commands",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    for (const times of [
      { at: Date.now() - 30_001, expiresAt: Date.now() - 1 },
      { at: Date.now(), expiresAt: Date.now() + 60_000 },
    ])
      assert.equal((await f.command("runtime-crash", { ...command, ...times })).status, 409);
    assert.deepEqual(f.old.calls.signals, []);
  },
);

test("operator crash refuses without a serving sibling", { timeout: 15_000 }, async (context) => {
  const { f, command, sibling } = await ready(context);
  f.instances.get(sibling.target.instanceId)!.fixture.crash();
  assert.equal((await f.command("runtime-crash", command)).status, 409);
  assert.deepEqual(f.old.calls.signals, []);
  assert.equal(await f.old.storage.get(crashAuditKey(command.nonce)), undefined);
});

test(
  "operator crash refuses a selected target that is no longer serving",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    f.old.crash();
    assert.equal((await f.command("runtime-crash", command)).status, 409);
    assert.deepEqual(f.old.calls.signals, []);
  },
);

test(
  "operator crash durably audits one SIGKILL and refuses replay after reconstruction",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    const before = await f.inspect();
    const signal = f.old.ctx.container.signal;
    let auditBeforeSignal: unknown;
    // The durable transaction callback observes committed storage before the synchronous signal.
    const previous = f.old.storage.afterCommit;
    f.old.storage.afterCommit = (keys) => {
      previous(keys);
      if (keys.includes(crashAuditKey(command.nonce))) auditBeforeSignal = true;
    };
    f.old.ctx.container.signal = (number) => {
      assert.equal(auditBeforeSignal, true);
      signal(number);
    };
    const response = await f.command("runtime-crash", command);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(f.old.calls.signals, [9]);
    assert.equal(f.old.calls.destroy, 0);
    assert.deepEqual(await f.inspect(), before, "fault injection must not change selection");
    const receipt = await f.old.storage.get<{ command: typeof command; status: string }>(
      crashAuditKey(command.nonce),
    );
    assert.equal(receipt?.command.operator, command.operator);
    assert.deepEqual(receipt?.command.identity, command.identity);
    assert.equal(receipt?.status, "signalled");
    f.reconstruct();
    assert.equal((await f.command("runtime-crash", command)).status, 409);
    const starts = f.old.calls.start;
    const inspected = await f.command("runtime-crash-inspect", {
      identity: command.identity,
      nonce: command.nonce,
    });
    assert.equal(inspected.status, 200);
    const body = (await inspected.json()) as {
      result: { target: { ready: boolean; audit: unknown } };
    };
    assert.equal(body.result.target.ready, false);
    assert.ok(body.result.target.audit);
    assert.equal(f.old.calls.start, starts, "inspection cannot repair compute");
    assert.deepEqual(f.old.calls.signals, [9]);
  },
);

test(
  "signed crash is detected by automatic supervision and requests keep succeeding during restart",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const entered = deferred(),
      release = deferred();
    context.after(() => {
      release.resolve();
    });
    const { f, command, sibling } = await ready(context);
    const seen = new Map<string, number>();
    f.onModel(async (instance, request) => {
      const id = new URL(request.url).searchParams.get("proof")!;
      seen.set(id, (seen.get(id) ?? 0) + 1);
      return new Response("served", {
        headers: { "x-fixture-runtime": instance.target.instanceId },
      });
    });
    const request = (id: string) => f.model(new Request(`http://pool/v1/models?proof=${id}`));
    const before = await Promise.all(Array.from({ length: 4 }, (_, i) => request(`before-${i}`)));
    for (const response of before) {
      assert.equal(response.status, 200);
      await response.body?.cancel();
    }
    f.old.hooks.health = async () => {
      if (f.old.calls.start) {
        entered.resolve();
        await release.promise;
      }
    };
    assert.equal((await f.command("runtime-crash", command)).status, 200);
    now += 2_000; // Deliver the scheduled supervision deadline, without a discovering request.
    const detection = now;
    const recoveryLogs = context.mock.method(console, "info", () => {});
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const deadlines = context.mock.method(AbortSignal, "timeout", (ms: number) => timeout(ms));
    await f.upkeep();
    await entered.promise;
    const during = await Promise.all(Array.from({ length: 12 }, (_, i) => request(`during-${i}`)));
    for (const response of during) {
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-fixture-runtime"), sibling.target.instanceId);
      await response.body?.cancel();
    }
    now = detection + 199_000;
    release.resolve();
    await f.settle();
    assert.equal(f.old.calls.start, 1);
    assert.notEqual(f.old.identity().bootId, command.identity.bootId);
    assert.ok(now - detection <= 204_000);
    const phases = recoveryLogs.mock.calls
      .filter((call) => call.arguments[0] === "POOL_SELECTED_RECOVERY")
      .map((call) => call.arguments[1] as { phase: string; at: number });
    assert.ok(phases.some((row) => row.phase === "detected"));
    assert.ok(phases.some((row) => row.phase === "starting"));
    const detectedAt = phases.find((row) => row.phase === "detected")!.at;
    const readyAt = phases.find((row) => row.phase === "ready")!.at;
    assert.ok(readyAt - detectedAt <= runtimeRecoveryBudgetMs);
    assert.ok(deadlines.mock.calls.some((call) => call.arguments[0] === runtimeRecoveryBudgetMs));
    const after = await Promise.all(Array.from({ length: 4 }, (_, i) => request(`after-${i}`)));
    for (const response of after) {
      assert.equal(response.status, 200);
      await response.body?.cancel();
    }
    assert.equal(seen.size, 20);
    for (const count of seen.values()) assert.equal(count, 1);
  },
);

for (const [path, status] of [
  ["responses", 503],
  ["messages", 529],
] as const)
  test(
    `the signed kill interrupts an accepted ${path} call with native retry advice and no server replay`,
    { timeout: 15_000 },
    async (context) => {
      const entered = deferred(),
        release = deferred();
      context.after(() => {
        release.resolve();
      });
      const { f, command } = await ready(context);
      let attempts = 0;
      context.mock.method(console, "error", () => {});
      f.onModel(async (instance) => {
        assert.equal(instance, f.old);
        attempts++;
        entered.resolve();
        await release.promise;
        throw new Error("synthetic port closed by SIGKILL");
      });
      const response = f.model(
        new Request(`http://pool/v1/${path}`, { method: "POST", body: "{}" }),
      );
      await entered.promise;
      assert.equal((await f.command("runtime-crash", command)).status, 200);
      release.resolve();
      const failed = await response;
      assert.equal(failed.status, status);
      assert.equal(failed.headers.get("Retry-After"), "1");
      await failed.body?.cancel();
      assert.equal(attempts, 1);
      f.onModel(async () => new Response("client retry succeeded"));
      const retry = await f.model(
        new Request(`http://pool/v1/${path}`, { method: "POST", body: "{}" }),
      );
      assert.equal(retry.status, 200);
      assert.equal(await retry.text(), "client retry succeeded");
      await f.settle();
      assert.deepEqual(f.old.calls.signals, [9]);
    },
  );
