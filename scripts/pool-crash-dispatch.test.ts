import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deploymentReadinessPrefix } from "../src/pool/deployment-readiness.ts";
import { openEnvelope } from "../src/pool/token.ts";
import {
  crashSender,
  logLine,
  observeSender,
  runCrashDispatch,
  writeDispatchResult,
  type DispatchDependencies,
  type DispatchInput,
} from "./pool-crash-dispatch.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

const accountId = "a".repeat(32);
const controllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
const identity = {
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "slot",
  applicationId: "application",
  applicationVersion: "1",
  instanceId: "instance",
  imageDigest: `sha256:${"e".repeat(64)}`,
  imageInput: "input",
  bootId: "boot",
};
const nonce = crypto.randomUUID();
const crashPacket = { controllerCode, identity, nonce, operator: "fixture-operator" };

const input = (overrides: Partial<DispatchInput> = {}): DispatchInput => ({
  mode: "apply",
  requestId: nonce,
  packet: JSON.stringify(crashPacket),
  coordinatorGo: "GO crash the selected primary",
  accountId,
  signingKey: randomBytes(32).toString("hex"),
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  runId: 7,
  runAttempt: "1",
  ...overrides,
});

function fakes(overrides: Partial<DispatchDependencies> = {}) {
  const calls: string[] = [];
  const deps: DispatchDependencies = {
    listRuns: async () => {
      calls.push("listRuns");
      return [{ id: 7, displayTitle: `pool-crash-operator apply ${nonce}` }];
    },
    readTarget: async () => {
      calls.push("readTarget");
      return { accountId, worker: "synthetic-pool" };
    },
    observe: async (action) => {
      calls.push(`observe:${action}`);
      return {
        result: action === "inspect" ? { action, selection: { slot: "primary" } } : { action },
      };
    },
    crash: async (_packet, apply) => {
      calls.push(apply ? "crash:apply" : "crash:inspect");
      return apply
        ? { inspection: false, result: { status: "signalled" } }
        : { inspection: true, result: { status: "audited" } };
    },
    now: () => 1,
    ...overrides,
  };
  return { deps, calls };
}

test("the workflow is main-only, serialized and gives only the operator step any secret", async () => {
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/pool-crash-operator.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), ["coordinator_go", "mode", "packet", "request_id"]);
  assert.deepEqual(inputs.mode.options, ["observe", "inspect", "apply"]);
  assert.equal(
    workflow["run-name"],
    "pool-crash-operator ${{ inputs.mode }} ${{ inputs.request_id }}",
  );
  assert.deepEqual(workflow.concurrency, {
    group: "pool-crash-operator",
    "cancel-in-progress": false,
  });
  assert.deepEqual(workflow.permissions, { contents: "read", actions: "read" });
  const job = workflow.jobs.operate;
  assert.equal(job.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(job.environment, { name: "production-release", deployment: false });
  const steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] = job.steps;
  const operator = steps.findIndex((step) => step.run === "bun scripts/pool-crash-dispatch.ts");
  assert.ok(operator > 0);
  steps.forEach((step, index) => {
    if (index !== operator) assert.ok(!JSON.stringify(step).includes("secrets."), String(index));
  });
  assert.equal(
    (steps[operator] as { env: Record<string, string> }).env.POOL_DEPLOYMENT_KEY,
    "${{ secrets.POOL_DEPLOYMENT_KEY }}",
  );
  const upload = steps.find((step) => step.uses === "actions/upload-artifact@v4");
  assert.equal(upload?.with?.name, "pool-crash-operator-result");
  assert.equal(upload?.with?.["retention-days"], 1);
  assert.match(String(upload?.with?.path), /\/result\.json$/u);
});

test("malformed dispatch inputs refuse by field before any read or send", async () => {
  const cases: [Partial<DispatchInput>, string][] = [
    [{ mode: "crash" }, "mode must be observe, inspect or apply"],
    [{ requestId: "not-a-uuid" }, "request_id must be a UUID"],
    [{ coordinatorGo: "  " }, "coordinator_go is empty"],
    [{ coordinatorGo: "GO <nonce>" }, "coordinator_go contains a bracket"],
    [{ coordinatorGo: "GO PLACEHOLDER" }, "coordinator_go contains a placeholder"],
    [{ coordinatorGo: "replace with GO" }, "coordinator_go contains a placeholder"],
    [{ coordinatorGo: "GO pending review" }, "coordinator_go contains a placeholder"],
    [{ coordinatorGo: "for example GO" }, "coordinator_go contains a placeholder"],
    [{ packet: "{" }, "packet is not valid JSON"],
    [
      { packet: JSON.stringify({ ...crashPacket, accountId }) },
      "packet must be exactly {controllerCode, identity, nonce, operator}",
    ],
    [
      { mode: "observe", packet: JSON.stringify(crashPacket) },
      "packet must be exactly {controllerCode}",
    ],
    [{ requestId: crypto.randomUUID() }, "request_id must equal packet.nonce"],
    [{ mode: "inspect", requestId: crypto.randomUUID() }, "request_id must equal packet.nonce"],
    [{ ref: "refs/heads/feature" }, "workflow must be dispatched on refs/heads/main"],
    [{ signingKey: "" }, "POOL_DEPLOYMENT_KEY is unavailable"],
  ];
  for (const [overrides, error] of cases) {
    const { deps, calls } = fakes();
    const result = await runCrashDispatch(input(overrides), deps);
    assert.equal(result.error, error, JSON.stringify(overrides));
    assert.equal(result.ok, false);
    assert.deepEqual(calls, []);
  }
});

test("the packet digest is canonical over the packet as supplied", async () => {
  const { deps } = fakes();
  const reordered = JSON.stringify({
    operator: "fixture-operator",
    nonce,
    identity,
    controllerCode,
  });
  const first = await runCrashDispatch(input({ mode: "inspect" }), deps);
  const second = await runCrashDispatch(input({ mode: "inspect", packet: reordered }), deps);
  assert.match(first.packetDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(first.packetDigest, second.packetDigest);
});

test("an earlier run titled with the nonce or a re-run forces inspect", async () => {
  const fresh = fakes();
  const applied = await runCrashDispatch(input(), fresh.deps);
  assert.deepEqual(fresh.calls, ["listRuns", "readTarget", "crash:apply"]);
  assert.equal(applied.forcedInspect, false);
  assert.deepEqual(applied.result, { status: "signalled" });

  const earlier = fakes({
    listRuns: async () => [
      { id: 7, displayTitle: `pool-crash-operator apply ${nonce}` },
      { id: 3, displayTitle: `pool-crash-operator inspect ${nonce}` },
    ],
  });
  const replay = await runCrashDispatch(input(), earlier.deps);
  assert.deepEqual(earlier.calls, ["readTarget", "crash:inspect"]);
  assert.equal(replay.forcedInspect, true);
  assert.equal(replay.mode, "inspect");
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.inspection, { status: "audited" });
  assert.equal(replay.result, undefined);

  const rerun = fakes();
  assert.equal(
    (await runCrashDispatch(input({ runAttempt: "2" }), rerun.deps)).forcedInspect,
    true,
  );
  assert.deepEqual(rerun.calls, ["readTarget", "crash:inspect"]);
});

test("an unreadable run list refuses apply without sending", async () => {
  const { deps, calls } = fakes({
    listRuns: async () => {
      throw new Error("forbidden");
    },
  });
  const result = await runCrashDispatch(input(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "workflow run list unavailable; apply refused");
  assert.deepEqual(calls, []);
});

test("a lost apply reply is reported as unknown and never retried", async () => {
  const sent: boolean[] = [];
  const { deps } = fakes({
    crash: async (_packet, apply) => {
      sent.push(apply);
      throw new Error("synthetic lost reply naming synthetic-pool");
    },
  });
  const result = await runCrashDispatch(input(), deps);
  assert.deepEqual(sent, [true]);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /^runtime-crash outcome unknown; never retry apply/u);
  assert.doesNotMatch(result.error ?? "", /synthetic-pool/u);
});

test("a release state for another account refuses before sending", async () => {
  const { deps, calls } = fakes({
    readTarget: async () => ({ accountId: "b".repeat(32), worker: "synthetic-pool" }),
  });
  const result = await runCrashDispatch(input({ mode: "inspect" }), deps);
  assert.equal(result.error, "release state accountId must equal CLOUDFLARE_ACCOUNT_ID");
  assert.deepEqual(calls, []);
});

test("result.json carries raw controller results but never the key or a signed envelope", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "pool-crash-dispatch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const signingKey = randomBytes(32).toString("hex");
  const envelopes: string[] = [];
  const actions: string[] = [];
  const signedAhead: number[] = [];
  const connect = async () => ({
    dispose: async () => {},
    env: {
      POOL_OPERATIONS: {
        fetch: async (request: Request) => {
          const { envelope } = (await request.json()) as { envelope: string };
          envelopes.push(envelope);
          const { action, at } = (await openEnvelope(
            signingKey,
            deploymentReadinessPrefix,
            envelope,
          )) as { action: string; at: number };
          actions.push(action);
          signedAhead.push(Date.now() - at);
          return Response.json(
            {
              result:
                action === "inspect" ? { action, selection: { identity } } : { action, identity },
            },
            { headers: { "x-private-header": "header-sentinel" } },
          );
        },
      },
    },
  });
  const scratch = join(directory, "runner-temp");
  await mkdir(scratch);
  const { deps } = fakes({ observe: observeSender(connect), crash: crashSender(scratch, connect) });
  const observed = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }), signingKey }),
    deps,
  );
  const inspected = await runCrashDispatch(input({ mode: "inspect", signingKey }), deps);
  assert.deepEqual(actions, ["inspect", "fleet-inspect", "active-health", "runtime-crash-inspect"]);
  assert.equal(observed.ok && inspected.ok, true);
  assert.deepEqual(observed.observe, {
    selection: { identity },
    fleet: { action: "fleet-inspect", identity },
    activeHealth: { action: "active-health", identity },
  });
  assert.deepEqual(inspected.inspection, { action: "runtime-crash-inspect", identity });
  // Commands are signed about two seconds in the past so a runner clock ahead of the controller passes.
  assert.ok(
    signedAhead.every((lag) => lag >= 2_000 && lag < 10_000),
    String(signedAhead),
  );
  assert.deepEqual(await readdir(scratch), []);
  for (const result of [observed, inspected]) {
    const output = join(directory, result.mode);
    await writeDispatchResult(output, result);
    const text = await readFile(join(output, "result.json"), "utf8");
    for (const secret of [signingKey, "header-sentinel", accountId, ...envelopes])
      assert.ok(!text.includes(secret));
    assert.equal(
      logLine(result),
      `mode=${result.mode} request_id=${nonce} ok=true forcedInspect=false\n`,
    );
  }
});

test("free-form inputs never reach the log line", async () => {
  const { deps } = fakes();
  const result = await runCrashDispatch(
    input({ mode: "::stop-commands::x", requestId: "::warning::x" }),
    deps,
  );
  assert.equal(logLine(result), "mode=invalid request_id=invalid ok=false forcedInspect=false\n");
});

test("observe keeps the selection and fleet when only the health read is refused", async () => {
  const { deps } = fakes({
    observe: async (action) => {
      if (action === "active-health") throw new Error("refused");
      return { result: action === "inspect" ? { selection: { slot: "primary" } } : { action } };
    },
  });
  const observed = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    deps,
  );
  assert.equal(observed.ok, true);
  assert.deepEqual(observed.observe, {
    selection: { slot: "primary" },
    fleet: { action: "fleet-inspect" },
    activeHealth: null,
  });
  const missing = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    fakes({ observe: async (action) => ({ result: { action } }) }).deps,
  );
  assert.equal(missing.error, "inspect reply has no result.selection");
});
