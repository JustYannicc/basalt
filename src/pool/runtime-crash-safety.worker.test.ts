import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import {
  crashAuditKey,
  RuntimeCrashCommand,
  RuntimeCrashInspectCommand,
} from "./runtime-crash-contract.ts";
import { RuntimeHandoffCommand } from "./runtime-slots/handoff-command.ts";
import { runtimeInput } from "./runtime-slots/input.ts";
import { runtimeErrorResponse } from "./runtime-slots/request-error.ts";
import { handleRuntimeHandoff } from "./runtime-slots/http.ts";
import { signEnvelope } from "./token.ts";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeHandoff } from "./runtime-slots/integration.ts";

async function ready(context: { after(fn: () => Promise<void>): void }) {
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  await f.send("fleet-configure", {
    operationId: "crash-safety",
    configuration: { ...f.configuration, targetActive: 1 },
  });
  const initial = await f.model();
  await initial.body?.cancel();
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
  return { f, sibling, command };
}

test(
  "operator crash refuses a healthy sibling with no spare capacity",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    const reservation = await new RuntimeFleetState(f.old.storage, 4).acquire(1);
    try {
      assert.equal((await f.command("runtime-crash", command)).status, 409);
      assert.deepEqual(f.old.calls.signals, []);
    } finally {
      await reservation.release();
    }
  },
);

test(
  "operator crash cannot target a sibling or an arbitrary runtime",
  { timeout: 15_000 },
  async (context) => {
    const { f, sibling, command } = await ready(context);
    assert.equal(
      (await f.command("runtime-crash", { ...command, identity: sibling.identity })).status,
      409,
    );
    assert.deepEqual(f.old.calls.signals, []);
    assert.deepEqual(f.instances.get(sibling.target.instanceId)!.fixture.calls.signals, []);
  },
);

test("failed audit persistence cannot signal compute", { timeout: 15_000 }, async (context) => {
  const { f, command } = await ready(context);
  const transaction = f.old.storage.transaction.bind(f.old.storage);
  context.mock.method(
    f.old.storage,
    "transaction",
    (work: Parameters<typeof f.old.storage.transaction>[0]) =>
      transaction(async (tx) =>
        work({
          ...tx,
          put: async (key: string | Record<string, unknown>, value?: unknown) => {
            if (typeof key === "string" && key === crashAuditKey(command.nonce))
              throw new Error("synthetic audit failure");
            if (typeof key === "string") return tx.put(key, value);
            return tx.put(key);
          },
        }),
      ),
  );
  context.mock.method(console, "error", () => {});
  assert.equal((await f.command("runtime-crash", command)).status, 500);
  assert.deepEqual(f.old.calls.signals, []);
});

test(
  "capacity observations expire before a delayed owner health reply can signal",
  { timeout: 15_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const { f, command } = await ready(context);
    let checks = 0;
    f.old.hooks.health = async () => {
      if (++checks === 2) now += 1_001;
    };
    assert.equal((await f.command("runtime-crash", command)).status, 409);
    assert.deepEqual(f.old.calls.signals, []);
  },
);

test(
  "concurrent crash nonces cannot signal the same boot twice",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    const responses = await Promise.all([
      f.command("runtime-crash", command),
      f.command("runtime-crash", { ...command, nonce: crypto.randomUUID() }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.deepEqual(f.old.calls.signals, [9]);
  },
);

test(
  "without the operator key neither the command nor direct owner transport can signal",
  { timeout: 15_000 },
  async (context) => {
    const { f, command, sibling } = await ready(context);
    const value = { ...command, controllerCode: runtimeFixtureCode, action: "runtime-crash" };
    for (const key of ["0".repeat(64), f.old.env.POOL_APP_SIGNING_KEY]) {
      const envelope = await signEnvelope(key, deploymentReadinessPrefix, value);
      context.mock.method(console, "error", () => {});
      const response = await f.worker.runtimeHandoff(
        new Request("http://operations/runtime-handoff", {
          method: "POST",
          body: JSON.stringify({ envelope }),
        }),
      );
      assert.ok(response.status >= 400);
    }
    // Even a valid operator command lacks the controller's short-lived capacity authorization.
    const envelope = await signEnvelope(
      f.old.env.POOL_DEPLOYMENT_KEY!,
      deploymentReadinessPrefix,
      value,
    );
    await assert.rejects(f.old.endpoint.crash(envelope));
    assert.deepEqual(f.old.calls.signals, []);
    assert.deepEqual(f.instances.get(sibling.target.instanceId)!.fixture.calls.signals, []);
  },
);

test(
  "pre-crash command contracts and controllers without the capability reject both actions as 409",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    const legacy = Schema.Union(
      RuntimeHandoffCommand.members.filter(
        (member) => member !== RuntimeCrashCommand && member !== RuntimeCrashInspectCommand,
      ),
    );
    for (const action of ["runtime-crash", "runtime-crash-inspect"]) {
      const value = {
        controllerCode: runtimeFixtureCode,
        action,
        identity: command.identity,
        nonce: command.nonce,
        at: command.at,
        expiresAt: command.expiresAt,
        ...(action === "runtime-crash" ? { operator: command.operator } : {}),
      };
      let refusal: Response | undefined;
      try {
        runtimeInput(() => Schema.decodeUnknownSync(legacy, { onExcessProperty: "error" })(value));
      } catch (error) {
        refusal = runtimeErrorResponse(error, "handoff");
      }
      assert.equal(refusal?.status, 409);
      const envelope = await signEnvelope(
        f.old.env.POOL_DEPLOYMENT_KEY!,
        deploymentReadinessPrefix,
        value,
      );
      const response = await handleRuntimeHandoff(
        new Request("http://operations/runtime-handoff", {
          method: "POST",
          body: JSON.stringify({ envelope }),
        }),
        new RuntimeHandoff(f.old.ctx, f.old.env, runtimeFixtureCode, { wrap: f.old.wrap }),
        runtimeFixtureCode,
        f.old.env.POOL_DEPLOYMENT_KEY!,
      );
      assert.equal(response.status, 409);
    }
    assert.deepEqual(f.old.calls.signals, []);
  },
);

test(
  "a boot change during audit persistence cannot signal the replacement boot",
  { timeout: 15_000 },
  async (context) => {
    const { f, command } = await ready(context);
    const afterCommit = f.old.storage.afterCommit;
    let changed = false;
    f.old.storage.afterCommit = (keys) => {
      afterCommit(keys);
      if (!changed && keys.includes(crashAuditKey(command.nonce))) {
        changed = true;
        f.old.replaceBoot();
      }
    };
    const response = await f.command("runtime-crash", command);
    assert.equal(changed, true);
    assert.equal(response.status, 409, await response.clone().text());
    assert.deepEqual(f.old.calls.signals, []);
    assert.equal(f.old.ctx.container.running, true);
    assert.notEqual(f.old.identity().bootId, command.identity.bootId);
  },
);
