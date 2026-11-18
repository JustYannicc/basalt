// The preflight's controller reads in the state release-main met right after a settlement: the
// prior candidate's adopted root was recovered (selection epoch 3), an authorized settlement
// archive releases this candidate, the deferred readiness row still names the controller before the
// prior one, the recovery GET answers 409 because a slot is selected, and no receipts exist.
// Only the state-store version read, the Node bridge (test/release-preflight-standins.ts) and the
// deployments GET are stand-ins; the journal, archive, readers, guard and handoff are real.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import { previousController } from "./test/settlement-controller.ts";
import { controllerRecoveredFixture, planSettlement } from "./test/settlement-plan.ts";
import { applyReleaseSettlement } from "./release-settlement-operation.ts";
import { releaseSettlementDigest } from "./release-settlement-contract.ts";
import { preflightRunner } from "./release-preflight.ts";
import { createPreflightBridgeCounters } from "./release-preflight-guard.ts";

const steps = new URL("./release-preflight-steps.ts", import.meta.url).href;
const standins = new URL("./test/release-preflight-standins.ts", import.meta.url).href;
const redirected = new Set(["./release-state-version.ts", "./release-preflight-guard.ts"]);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === steps && redirected.has(specifier))
      return { url: standins, shortCircuit: true };
    return next(specifier, context);
  },
});
const { preflightSteps } = await import("./release-preflight-steps.ts");
const standin = await import("./test/release-preflight-standins.ts");

async function settledRecoveredState(context: TestContext) {
  const f = await controllerRecoveredFixture(context);
  const manifest = await planSettlement(f, "controller-active-adopted");
  await Effect.runPromise(
    f.provide(
      applyReleaseSettlement(
        f.compiled,
        manifest,
        f.key,
        {
          coordinatorGo: "apply-reviewed-packet",
          writerLease: f.provisioningWriter.lease,
          manifest: releaseSettlementDigest(manifest),
          expiresAt: Date.now() + 60_000,
        },
        f.io,
      ),
    ),
  );
  assert.deepEqual(manifest.proof.controller.code, f.code);
  assert.ok(f.io.connect);
  standin.installPoolOperations(f.io.connect);
  // The preflight reads through the compiled stack's own HTTP client, so answer its deployments
  // GET from the same active versions the fixture's client serves.
  context.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const worker = url.pathname.split("/").at(-2)!;
    if (!url.pathname.endsWith("/deployments") || !f.active.has(worker))
      throw new Error("No network in the offline preflight proof");
    const versions = f.active.get(worker)!;
    return Response.json({
      success: true,
      result: {
        deployments: [
          {
            id: `deployment-${worker}`,
            created_on: "2026-01-01T00:00:00Z",
            versions: versions.map((row) => ({
              version_id: row.versionId,
              percentage: row.percentage,
            })),
          },
        ],
      },
    });
  });
  return f;
}

async function preflight(f: Awaited<ReturnType<typeof settledRecoveredState>>) {
  const runner = preflightRunner();
  const attempts: Parameters<typeof preflightSteps>[1]["attempts"] = [];
  await Effect.runPromise(
    f.provide(
      preflightSteps(f.compiled, {
        candidate: f.candidate,
        state: f.state,
        fetch: async () => {
          throw new Error("No network in the offline preflight proof");
        },
        bridge: createPreflightBridgeCounters(),
        runner,
        credentials: { accountId: f.accountId, apiToken: "synthetic", encryptionKey: f.key },
        directory: f.io.directory,
        receipts: [],
        attempts,
      }),
    ),
  );
  const result = (name: string) => runner.results.find((row) => row.step === name);
  return { results: runner.results, result, attempts };
}

test("after a settlement the preflight inspects with the archive's live controller code", async (context) => {
  const f = await settledRecoveredState(context);
  const stale = previousController(f.accountId, "0").code;
  const { result, attempts, results } = await preflight(f);
  assert.deepEqual(
    result("live-controller"),
    {
      step: "live-controller",
      status: "pass",
      summary: {
        source: "journal-source",
        candidate: f.code.candidate,
        selected: true,
        dirtyPolicies: 6,
      },
    },
    JSON.stringify({ results, attempts }),
  );
  assert.deepEqual(attempts, [
    {
      source: "journal-source",
      ...f.code,
      route: "PoolOperations POST /runtime-handoff inspect",
      outcome: "accepted",
    },
  ]);
  assert.ok(attempts.every((attempt) => attempt.candidate !== stale.candidate));
  assert.deepEqual(result("baseline-controller"), {
    step: "baseline-controller",
    status: "pass",
    summary: { candidate: f.code.candidate, source: "journal-source" },
  });
  assert.deepEqual(result("release-journal"), {
    step: "release-journal",
    status: "pass",
    summary: { record: "prior-settled-or-aborted", sourceCandidate: f.code.candidate },
  });
  // The later controller reads take the recovered epoch and the selected legacy root as they are.
  // provider-observe is left out: the stand-in controller does not model that action.
  assert.deepEqual(
    [
      "selection-proof",
      "active-health",
      "baseline-health",
      "adoption-reads",
      "fleet-inspect",
      "witness",
      "image-capacity",
      "final-readiness",
    ].map((name) => [name, result(name)?.status]),
    [
      ["selection-proof", "pass"],
      ["active-health", "pass"],
      ["baseline-health", "not-applicable"],
      ["adoption-reads", "not-applicable"],
      ["fleet-inspect", "pass"],
      ["witness", "pass"],
      ["image-capacity", "pass"],
      ["final-readiness", "not-applicable"],
    ],
  );
  assert.deepEqual(result("selection-proof"), {
    step: "selection-proof",
    status: "pass",
    summary: { expectedEpoch: 3, revisions: 7 },
  });
});
