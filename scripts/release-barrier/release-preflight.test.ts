// Regression: release-preflight-refusals (the read-only preflight refuses mutations and unsupported settlements before a release starts)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signEnvelope } from "../../src/pool/token.ts";
import { deploymentReadinessPath } from "../../src/pool/deployment-readiness.ts";
import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { runtimeRecoveryPath } from "../../src/pool/runtime-recovery.ts";
import { BarrierRefusal } from "./refusal.ts";
import { openDeploymentReadiness } from "../database-budget-readiness.ts";
import {
  NotApplicable,
  SettlementRequired,
  preflightRefusal,
  preflightRunner,
} from "./release-preflight.ts";
import { finalReadiness } from "./release-preflight-steps.ts";
import {
  liveControllerCodes,
  releaseReceiptCodes,
  settlementVerdict,
  supportedDispositions,
} from "./release-preflight-live.ts";
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
  const clean = {
    candidate: "a".repeat(40),
    mode: "check" as const,
    steps: [],
    state,
    bridge: counters,
  };
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
    mode: "check",
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

// The controller as production runs it: it accepts a signed inspect only for its own code.
const liveCode = { candidate: "1".repeat(40), workerInput: "2".repeat(64) };
const recordedCode = { candidate: "3".repeat(40), workerInput: "4".repeat(64) };
const accepts = (code: typeof liveCode) => JSON.stringify(code) === JSON.stringify(liveCode);

test("the receipt for the journal's unsettled prior candidate is tried even when the running release is unknown", () => {
  const codes = liveControllerCodes({
    recorded: recordedCode,
    prior: liveCode.candidate,
    running: undefined,
    receipts: [{ candidate: "6".repeat(40), workerInput: "7".repeat(64) }, liveCode],
    workerInput: "5".repeat(64),
  });
  assert.deepEqual(
    codes.map(({ source }) => source),
    ["recorded", "prior-release-receipt"],
  );
  assert.equal(codes.find(({ code }) => accepts(code))?.source, "prior-release-receipt");
});

test("without a release receipt the lagging recorded code is all there is, and inspect refuses", () => {
  const codes = liveControllerCodes({
    recorded: recordedCode,
    running: liveCode.candidate,
    receipts: [],
    workerInput: "5".repeat(64),
  });
  assert.equal(
    codes.some(({ code }) => accepts(code)),
    false,
  );
});

test("the release receipt for the running release supplies the code the controller accepts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preflight-receipts-"));
  try {
    for (const [run, code] of [
      ["101", { candidate: "6".repeat(40), workerInput: "7".repeat(64) }],
      ["102", liveCode],
    ] as const) {
      await mkdir(join(directory, run, "nested"), { recursive: true });
      await writeFile(
        join(directory, run, "nested", "provider-observation.json"),
        JSON.stringify({ status: "refused", ...code, at: 1 }),
      );
    }
    await writeFile(join(directory, "101", "provider-observation.json"), "not json");
    const receipts = await releaseReceiptCodes(directory);
    const codes = liveControllerCodes({
      recorded: recordedCode,
      running: liveCode.candidate,
      receipts,
      workerInput: "5".repeat(64),
    });
    assert.deepEqual(
      codes.map(({ source }) => source),
      ["recorded", "release-receipt", "checkout-revision"],
    );
    assert.equal(codes.find(({ code }) => accepts(code))?.source, "release-receipt");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(await releaseReceiptCodes(undefined), []);
});

test("an unsettled prior candidate needs the settlement its live controller state implies", () => {
  const prior = "8".repeat(40);
  // Support follows this candidate's own disposition list, so the test holds with or without
  // a change that adds a disposition.
  for (const [liveCandidate, selected, disposition] of [
    [prior, true, "controller-active-adopted"],
    [prior, false, "controller-active-unadopted"],
    ["9".repeat(40), true, "abandoned-before-controller"],
  ] as const)
    assert.deepEqual(settlementVerdict({ prior, liveCandidate, selected }), {
      disposition,
      supported: supportedDispositions.includes(disposition),
    });
});

test("a disposition missing from the candidate's list is unsupported and refuses everywhere", async () => {
  const prior = "8".repeat(40);
  const verdict = settlementVerdict({
    prior,
    liveCandidate: prior,
    selected: true,
    supported: ["abandoned-before-controller", "controller-active-unadopted"],
  });
  assert.deepEqual(verdict, { disposition: "controller-active-adopted", supported: false });
});

test("once the candidate can perform the settlement, it is required: Check passes, the release blocks", async () => {
  const prior = "8".repeat(40);
  const verdict = settlementVerdict({
    prior,
    liveCandidate: prior,
    selected: true,
    supported: [
      "abandoned-before-controller",
      "controller-active-unadopted",
      "controller-active-adopted",
    ],
  });
  assert.deepEqual(verdict, { disposition: "controller-active-adopted", supported: true });
  const runner = preflightRunner();
  await runner.step("release-settlement", [], async () => {
    throw new SettlementRequired(verdict.disposition);
  });
  const status = (mode: "check" | "release") =>
    preflightReport({
      candidate: "a".repeat(40),
      mode,
      steps: runner.results,
      state: createRehearsalCounters(),
      bridge: createPreflightBridgeCounters(),
    }).status;
  assert.equal(status("check"), "pass");
  assert.equal(status("release"), "refused");
});

test("a required settlement reports in Check but blocks the release; an unsupported one blocks both", async () => {
  const runner = preflightRunner();
  await runner.step("release-settlement", [], async () => {
    throw new SettlementRequired("controller-active-adopted");
  });
  const report = (mode: "check" | "release", steps = runner.results) =>
    preflightReport({
      candidate: "a".repeat(40),
      mode,
      steps,
      state: createRehearsalCounters(),
      bridge: createPreflightBridgeCounters(),
    }).status;
  assert.deepEqual(runner.results, [
    {
      step: "release-settlement",
      status: "settlement-required",
      disposition: "controller-active-adopted",
    },
  ]);
  assert.equal(report("check"), "pass");
  assert.equal(report("release"), "refused");
  const unsupported = preflightRunner();
  await unsupported.step("release-settlement", [], async () => {
    throw new BarrierRefusal(
      "release-preflight-settlement-unsupported",
      "controller-active-adopted",
    );
  });
  assert.equal(report("check", unsupported.results), "refused");
  assert.equal(report("release", unsupported.results), "refused");
});

test("a refused readiness read keeps the server's fixed outcome and stage, never other body text", async () => {
  const open = (body: string) =>
    openDeploymentReadiness({
      worker: "pool",
      accountId: "account",
      key,
      target: { candidate: "c".repeat(40), workerInput: "d".repeat(64), imageHash: "e" },
      connect: async () => ({
        env: { POOL_OPERATIONS: { fetch: async () => new Response(body, { status: 503 }) } },
        dispose: async () => {},
      }),
    });
  const refused = async (body: string) => {
    const connection = await open(body);
    try {
      await connection.ready(AbortSignal.timeout(5_000));
    } catch (error) {
      return preflightRefusal(error);
    } finally {
      await connection.close();
    }
    throw new Error("readiness unexpectedly passed");
  };
  assert.deepEqual(
    await refused(JSON.stringify({ outcome: "readiness-error", stage: "readiness" })),
    {
      reason: "deployment-readiness-readiness-error",
      field: "readiness.readiness",
      status: 503,
    },
  );
  assert.deepEqual(await refused(JSON.stringify({ outcome: "Secret 0123 value", stage: 7 })), {
    reason: "deployment-readiness-refused",
    field: null,
    status: 503,
  });
});

const legacyRoot = {
  format: "pool-runtime-slot-v1",
  controllerId: "f".repeat(64),
  instanceId: "f".repeat(64),
  slotId: "legacy",
  applicationId: "pool-app",
  applicationVersion: "57",
  imageDigest: `sha256:${"1".repeat(64)}`,
  imageInput: "a".repeat(16),
} as const;
const readinessFor = async (target: typeof legacyRoot | typeof fleetPrimary) => {
  let read = 0;
  const selection = {
    epoch: 3,
    active: { target, identity: { ...target, bootId: "recovered-boot" }, fenced: false },
  };
  const outcome = await finalReadiness(selection, async () => {
    read++;
    return "ready";
  }).catch((error: unknown) => error);
  return { read, outcome };
};
const fleetPrimary = {
  ...legacyRoot,
  slotId: "fleet-blue",
  applicationId: "blue-app",
  instanceId: "c".repeat(64),
};

test("final readiness is post-promote-only while the legacy root is active, adopted or recovered", async () => {
  // A recovered root at epoch 3 answers an attested restart witness, yet is still the legacy slot.
  const { read, outcome } = await readinessFor(legacyRoot);
  assert.equal(read, 0);
  assert.ok(outcome instanceof NotApplicable);
  assert.equal(outcome.why, "post-promote-only: the active slot is the legacy root");
  assert.deepEqual(await readinessFor(fleetPrimary), { read: 1, outcome: "ready" });
});
