import assert from "node:assert/strict";
import { test } from "node:test";
import { signEnvelope } from "../../src/pool/token.ts";
import { deploymentReadinessPath } from "../../src/pool/deployment-readiness.ts";
import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { BarrierRefusal } from "./refusal.ts";
import { NotApplicable, preflightRunner } from "./release-preflight.ts";
import { preflightReport } from "./release-preflight-report.ts";
import { createRehearsalCounters } from "./release-resume-rehearsal.ts";
import {
  createPreflightBridgeCounters,
  readOnlyPoolOperations,
  readOnlyReleaseWriter,
} from "./release-preflight-guard.ts";

const key = "a".repeat(64);
const controllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
// A command as the release signs it: closed fields and a live one-minute window.
const command = (fields: Record<string, unknown>) => {
  const at = Date.now();
  return { ...fields, controllerCode, at, expiresAt: at + 60_000 };
};

async function bridge() {
  const sent: string[] = [];
  const counters = createPreflightBridgeCounters();
  const connect = readOnlyPoolOperations(
    async () => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request: Request) => {
            sent.push(`${request.method} ${new URL(request.url).pathname}`);
            return new Response(JSON.stringify({ result: { leaseMs: 1_500 } }));
          },
        },
      },
      dispose: async () => {},
    }),
    key,
    counters,
  );
  const platform = await connect("unused");
  const send = async (path: string, value: unknown) =>
    platform.env.POOL_OPERATIONS.fetch(
      new Request(`http://pool-operations${path}`, {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(key, runtimeHandoffCommandPrefix, value),
        }),
      }),
    );
  return { sent, counters, platform, send };
}

test("the read-only bridge refuses every mutation before it reaches the controller", async () => {
  const { sent, counters, send } = await bridge();
  for (const [action, fields] of [
    ["adopt", { proof: "p" }],
    ["stage", { proof: "p" }],
    ["drain", { operationId: "op" }],
    ["discard", { operationId: "op" }],
    ["image-cancel", { operationId: "op" }],
    ["candidate-probe-cancel", { operationId: "op" }],
  ] as const)
    await assert.rejects(
      send(runtimeHandoffPath, command({ action, ...fields })),
      (error) =>
        error instanceof BarrierRefusal &&
        error.reason === "release-preflight-mutation-refused" &&
        error.worker === `bridge.mutation:${action}`,
    );
  await assert.rejects(send(deploymentReadinessPath, { phase: "adoption" }), BarrierRefusal);
  assert.deepEqual(sent, []);
  assert.equal(counters.refused["mutation:adopt"], 1);
  assert.equal(counters.refused["mutation:readiness-adoption"], 1);
});

test("a read action with extra fields or an expired window is refused", async () => {
  const { sent, counters, send } = await bridge();
  await assert.rejects(
    send(runtimeHandoffPath, command({ action: "inspect", proof: "smuggled" })),
    BarrierRefusal,
  );
  await assert.rejects(
    send(runtimeHandoffPath, { action: "inspect", controllerCode, at: 1, expiresAt: 2 }),
    BarrierRefusal,
  );
  assert.deepEqual(sent, []);
  assert.equal(counters.refused["invalid-command"], 2);
});

test("the read-only bridge refuses unsigned, foreign and unknown requests", async () => {
  const { sent, platform } = await bridge();
  const forged = await signEnvelope(
    "b".repeat(64),
    runtimeHandoffCommandPrefix,
    command({ action: "inspect" }),
  );
  for (const request of [
    new Request(`http://pool-operations${runtimeHandoffPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope: forged }),
    }),
    new Request(`http://pool-operations${runtimeHandoffPath}`, { method: "POST", body: "{}" }),
    new Request(`http://pool-operations${runtimeRecoveryPath}?repair=1`),
    new Request(`http://pool-operations${runtimeRecoveryPath}`, { method: "DELETE" }),
    new Request("http://pool-operations/anything", { method: "POST", body: "{}" }),
  ])
    await assert.rejects(platform.env.POOL_OPERATIONS.fetch(request), BarrierRefusal);
  assert.deepEqual(sent, []);
});

test("the read-only bridge passes the release's reads unchanged", async () => {
  const { sent, counters, platform, send } = await bridge();
  for (const action of ["inspect", "active-health", "fleet-inspect"])
    await send(runtimeHandoffPath, command({ action }));
  await send(deploymentReadinessPath, { candidate: "c" });
  await platform.env.POOL_OPERATIONS.fetch(
    new Request(`http://pool-operations${runtimeRecoveryPath}`),
  );
  assert.equal(sent.length, 5);
  assert.deepEqual(counters.refused, {});
  assert.equal(counters.dispatched["active-health"], 1);
  assert.equal(counters.dispatched["readiness-runtime"], 1);
  assert.equal(counters.dispatched["recovery-health"], 1);
});

test("each active-health read records its granted lease, request leg, close and margin", async () => {
  const { counters, platform, send } = await bridge();
  await send(runtimeHandoffPath, command({ action: "inspect" }));
  const response = await send(runtimeHandoffPath, command({ action: "active-health" }));
  assert.deepEqual(await response.json(), { result: { leaseMs: 1_500 } });
  await platform.dispose();
  assert.equal(counters.health.length, 1);
  const [call] = counters.health;
  assert.equal(call!.leaseMs, 1_500);
  assert.ok(call!.requestLegMs >= 0 && call!.closeMs !== null && call!.closeMs >= 0);
  // The margin spends the request leg and the close; the setup-inclusive one also spends setup.
  assert.ok(call!.marginMs! <= 1_500 - call!.requestLegMs + 0.1);
  assert.ok(call!.marginMs! <= 1_500 - call!.closeMs! + 0.1);
  assert.ok(call!.setupInclusiveMarginMs! <= call!.marginMs! - call!.setupMs + 0.1);
});

test("a refusal naming a live identifier publishes only its digest", async () => {
  const runner = preflightRunner();
  await runner.step("selection-proof", [], async () => {
    throw new BarrierRefusal("runtime-release-application-not-retained", "0f3c9a1e-77aa-4c2b");
  });
  const [result] = runner.results;
  assert.equal(result!.status, "refused");
  assert.match(
    result!.status === "refused" ? (result!.refusal.field ?? "") : "",
    /^digest:[a-f0-9]{16}$/u,
  );
});

test("an attempted write fails the report even when every step passed", () => {
  const state = createRehearsalCounters();
  const counters = createPreflightBridgeCounters();
  const clean = { candidate: "a".repeat(40), steps: [], state, bridge: counters };
  assert.equal(preflightReport(clean).status, "pass");
  counters.refused["mutation:adopt"] = 1;
  assert.equal(preflightReport(clean).status, "refused");
  state.state.writeAttempts = 1;
  assert.equal(
    preflightReport({ ...clean, bridge: createPreflightBridgeCounters() }).status,
    "refused",
  );
});

test("the read-only writer refuses every write path", async () => {
  const writer = readOnlyReleaseWriter("a".repeat(40));
  writer.assert();
  assert.throws(() => writer.enable("digest"), BarrierRefusal);
  let ran = false;
  await assert.rejects(
    writer.exclusive(async () => {
      ran = true;
    }),
    (error) => error instanceof BarrierRefusal && error.worker === "writer.exclusive",
  );
  assert.equal(ran, false);
});

test("the runner reports every refusal and skips only dependent steps", async () => {
  const runner = preflightRunner();
  await runner.step("a", [], async () => {
    throw new BarrierRefusal("runtime-release-health-expired", "PoolWorker");
  });
  await runner.step("b", ["a"], async () => "never");
  await runner.step("c", [], async () => {
    throw new NotApplicable("no selection");
  });
  await runner.step("d", [], async () => {
    throw new BarrierRefusal("provisioning-input-drift", "runtime-release.controller-code", {
      fqn: "PoolWorker",
      type: "Cloudflare.Worker",
      changed: [
        { path: "secret.value", old: "live-secret", new: "other" },
        { path: "handoff.response.code", old: null, new: "identity" },
      ],
    });
  });
  await runner.step(
    "e",
    [],
    async () => 1,
    (value) => ({ value }),
  );
  const report = preflightReport({
    candidate: "a".repeat(40),
    steps: runner.results,
    state: createRehearsalCounters(),
    bridge: createPreflightBridgeCounters(),
  });
  assert.equal(report.status, "refused");
  assert.deepEqual(runner.results, [
    {
      step: "a",
      status: "refused",
      refusal: { reason: "runtime-release-health-expired", field: "PoolWorker" },
    },
    { step: "b", status: "skipped", needs: ["a"] },
    { step: "c", status: "not-applicable", why: "no selection" },
    {
      step: "d",
      status: "refused",
      refusal: {
        reason: "provisioning-input-drift",
        field: "runtime-release.controller-code",
        // Live values stay out of the report; the server's closed vocabulary stays in.
        paths: [
          { path: "secret.value" },
          { path: "handoff.response.code", old: null, new: "identity" },
        ],
      },
    },
    { step: "e", status: "pass", summary: { value: 1 } },
  ]);
});
