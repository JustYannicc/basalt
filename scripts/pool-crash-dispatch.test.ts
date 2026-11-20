import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deploymentReadinessPrefix } from "../src/pool/deployment-readiness.ts";
import { openEnvelope } from "../src/pool/token.ts";
import { RunListRefused } from "./pool-crash-dispatch-sources.ts";
import {
  ControllerRefused,
  crashSender,
  logLine,
  observeSender,
  rootHealthReader,
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
const root = {
  applicationId: "root-application",
  applicationVersion: "57",
  imageDigest: `sha256:${"9".repeat(64)}`,
  imageInput: "root-input",
};
const rootInstance = "f".repeat(64);
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
      return { accountId, worker: "synthetic-pool", root };
    },
    rootHealth: async () => {
      calls.push("rootHealth");
      return { instanceId: rootInstance, imageHash: "h", running: true, ready: true, bootId: "rb" };
    },
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
    },
    observe: async (action) => {
      calls.push(`observe:${action}`);
      return {
        result: action === "inspect" ? { action, selection: { slot: "primary" } } : { action },
      };
    },
    crash: async ({ mode }) => {
      calls.push(`crash:${mode}`);
      return mode === "apply"
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
    group: "deploy-production",
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
    [{ event: "push" }, "workflow event must be workflow_dispatch"],
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

test("the packet digest is the sha256 of the exact raw packet input", async () => {
  const { deps } = fakes();
  const raw = input({ mode: "inspect" }).packet;
  const spaced = ` ${raw}`;
  const first = await runCrashDispatch(input({ mode: "inspect" }), deps);
  const second = await runCrashDispatch(input({ mode: "inspect", packet: spaced }), deps);
  assert.equal(first.packetDigest, createHash("sha256").update(raw).digest("hex"));
  assert.equal(second.packetDigest, createHash("sha256").update(spaced).digest("hex"));
  assert.notEqual(first.packetDigest, second.packetDigest);
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
  const sent: string[] = [];
  const { deps } = fakes({
    crash: async ({ mode }) => {
      sent.push(mode);
      throw new Error("synthetic lost reply naming synthetic-pool");
    },
  });
  const result = await runCrashDispatch(input(), deps);
  assert.deepEqual(sent, ["apply"]);
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
  const { bootId: _bootId, ...target } = identity;
  const selection = { epoch: 1, active: { target, identity, fenced: false } };
  const witnessed: unknown[] = [];
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
          const opened = (await openEnvelope(signingKey, deploymentReadinessPrefix, envelope)) as {
            action: string;
            at: number;
            target?: unknown;
          };
          const { action, at } = opened;
          actions.push(action);
          if (action === "witness") witnessed.push(opened.target);
          signedAhead.push(Date.now() - at);
          return Response.json(
            {
              result:
                action === "inspect"
                  ? { action, selection }
                  : action === "witness"
                    ? { kind: "witness", witness: { bootId: identity.bootId } }
                    : { action, identity },
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
  assert.deepEqual(actions, [
    "inspect",
    "fleet-inspect",
    "active-health",
    "witness",
    "inspect",
    "runtime-crash-inspect",
  ]);
  assert.equal(observed.ok && inspected.ok, true);
  // The signed witness names the selected primary exactly as the controller reported it.
  assert.deepEqual(witnessed, [target]);
  assert.deepEqual(observed.observe, {
    selection,
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
    // This fixture's release state names no provider target, so observe says so and sends none.
    assert.equal(
      logLine(result),
      `mode=${result.mode} request_id=${nonce} ok=true forcedInspect=false\n` +
        (result.mode === "observe"
          ? "provider observation: does not read (target_unavailable)\n"
          : ""),
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
      if (action === "active-health") throw new ControllerRefused("active-health", "unhealthy");
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
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.observe, {
    selection: null,
    fleet: { action: "fleet-inspect" },
    activeHealth: { action: "active-health" },
  });
});

const pool = "pool-sentinel-0001";
const organization = "org-sentinel-0002";
const account = "account-sentinel-0003";
const hashed = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

test("a missing selection is diagnosed with reads only and hashed membership identifiers", async () => {
  const sent: { action: string; slot?: unknown }[] = [];
  let expiresAt = 1_000;
  const { deps, calls } = fakes({
    observe: async (action, _code, _target, _key, slot) => {
      sent.push({ action, ...(slot ? { slot } : {}) });
      if (action === "active-health") throw new ControllerRefused(action, "selection");
      if (action === "witness") throw new ControllerRefused(action, "identity");
      if (action === "fleet-inspect")
        return { result: { permission: { enabled: false }, resources: [], bindings: [{}] } };
      expiresAt += 5_000;
      return {
        result: {
          policies: [
            { pool, organization, revision: 3, expiresAt, accounts: [account], dirty: false },
          ],
          denials: [
            { pool, organization, revision: 2, expiresAt: 0, accounts: [account], dirty: true },
          ],
          digest: "policy-digest",
        },
      };
    },
  });
  const observed = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    deps,
  );
  assert.equal(observed.ok, true);
  assert.equal((observed.observe as { selection: unknown }).selection, null);
  assert.deepEqual(
    sent.map(({ action }) => action),
    ["inspect", "fleet-inspect", "active-health", "witness", "inspect"],
  );
  // The witness names the legacy slot of the root application the release state retains.
  assert.deepEqual(sent[3]!.slot, {
    format: "pool-runtime-slot-v1",
    controllerId: rootInstance,
    instanceId: rootInstance,
    slotId: "legacy",
    ...root,
  });
  assert.ok(calls.indexOf("sleep:6000") > calls.indexOf("rootHealth"));
  const row = (at: number) => ({
    pool: hashed(pool),
    organization: hashed(organization),
    revision: 3,
    expiresAt: at,
    dirty: false,
    accounts: [hashed(account)],
  });
  const denial = { ...row(0), revision: 2, dirty: true };
  assert.deepEqual(observed.diagnostic, {
    inspect: [
      {
        observedAt: 1,
        selectionPresent: false,
        policies: [row(6_000)],
        denials: [denial],
        digest: "policy-digest",
      },
      {
        observedAt: 1,
        selectionPresent: false,
        policies: [row(11_000)],
        denials: [denial],
        digest: "policy-digest",
      },
    ],
    fleet: { enabled: false, resources: 0, bindings: 1 },
    activeHealth: { refused: "selection" },
    root: {
      instanceId: hashed(rootInstance),
      imageHash: "h",
      stateImageInput: root.imageInput,
      running: true,
      ready: true,
      bootId: "rb",
    },
    witness: { ok: false, refused: "identity" },
  });
  const published = JSON.stringify(observed);
  for (const raw of [pool, organization, account, rootInstance])
    assert.ok(!published.includes(raw));
});

test("both retained witness shapes report their operation, and lost reads stay evidence", async () => {
  const operationId = `adopt-${"c".repeat(40)}`;
  const witnessOf = async (reply: unknown) =>
    (
      (
        await runCrashDispatch(
          input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
          fakes({
            observe: async (action) => ({ result: action === "witness" ? reply : { action } }),
          }).deps,
        )
      ).diagnostic as { witness: unknown }
    ).witness;
  // The controller's unattested adoption readback is flat.
  assert.deepEqual(
    await witnessOf({
      kind: "unattested-active",
      controllerCode,
      operationId,
      manifestDigest: "m",
      identity: { ...identity, bootId: "old-boot" },
      configurationFingerprint: "f",
      selection: {},
    }),
    {
      slotId: "legacy",
      kind: "unattested-active",
      operationId,
      manifestDigest: "m",
      bootId: "old-boot",
    },
  );
  // An attested slot nests its startup witness.
  assert.deepEqual(
    await witnessOf({
      kind: "witness",
      controllerCode,
      witness: { operationId: "start-1", manifestDigest: "n", bootId: "attested-boot" },
    }),
    {
      slotId: "legacy",
      kind: "witness",
      operationId: "start-1",
      manifestDigest: "n",
      bootId: "attested-boot",
    },
  );
  const lostWitness = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    fakes({
      observe: async (action) => {
        if (action === "witness") throw new Error("synthetic lost reply");
        return { result: { action } };
      },
    }).deps,
  );
  assert.deepEqual((lostWitness.diagnostic as { witness: unknown }).witness, {
    ok: false,
    error: "witness outcome unknown",
  });
  const undigested = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    fakes({
      observe: async (action) => ({ result: { action } }),
      readTarget: async () => ({
        accountId,
        worker: "synthetic-pool",
        root: { ...root, imageDigest: "" },
      }),
    }).deps,
  );
  assert.deepEqual((undigested.diagnostic as { witness: unknown }).witness, {
    ok: false,
    error: "root image digest unavailable in release state; witness not sent",
  });
  const { deps, calls } = fakes({
    rootHealth: async () => {
      throw new Error("synthetic bridge failure");
    },
    observe: async (action) => {
      if (action === "inspect" && calls.includes("sleep:6000")) throw new Error("lost");
      return { result: { action } };
    },
  });
  const lost = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    deps,
  );
  assert.equal(lost.ok, true);
  const diagnostic = lost.diagnostic as { root: unknown; witness: unknown; inspect: unknown[] };
  assert.deepEqual(diagnostic.root, { ok: false, error: "root health read failed" });
  assert.deepEqual(diagnostic.witness, {
    ok: false,
    error: "root health unavailable; witness not sent",
  });
  assert.deepEqual(diagnostic.inspect[1], { ok: false, error: "second inspect outcome unknown" });
});

test("the root health read is an unsigned GET of the recovery status", async () => {
  const requests: string[] = [];
  const health = await rootHealthReader(async () => ({
    dispose: async () => {},
    env: {
      POOL_OPERATIONS: {
        fetch: async (request: Request) => {
          requests.push(`${request.method} ${new URL(request.url).pathname}`);
          return Response.json({ instanceId: rootInstance, running: true });
        },
      },
    },
  }))({ accountId, worker: "synthetic-pool" });
  assert.deepEqual(requests, ["GET /runtime-recovery"]);
  assert.deepEqual(health, { instanceId: rootInstance, running: true });
});

test("an observe whose health read is lost, not refused, fails instead of recording null", async () => {
  const { deps } = fakes({
    observe: async (action) => {
      if (action === "active-health") throw new Error("synthetic lost reply");
      return { result: action === "inspect" ? { selection: { slot: "primary" } } : { action } };
    },
  });
  const observed = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    deps,
  );
  assert.equal(observed.ok, false);
  assert.equal(observed.error, "active-health outcome unknown");
});

test("the public result replaces the account wherever a raw controller reply carries it", async () => {
  const { deps } = fakes({
    observe: async (action) => ({
      result:
        action === "inspect"
          ? { selection: { slot: "primary" } }
          : { permission: { configuration: { applications: [{ accountId, color: "blue" }] } } },
    }),
  });
  const observed = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    deps,
  );
  assert.equal(observed.ok, true);
  assert.doesNotMatch(JSON.stringify(observed), new RegExp(accountId));
  assert.match(JSON.stringify(observed.observe), /redacted-account/);
});

test("only the controller's own 409 refusal makes the health read null", async () => {
  const signingKey = randomBytes(32).toString("hex");
  const sender = (status: number, body: unknown) =>
    observeSender(async () => ({
      dispose: async () => {},
      env: { POOL_OPERATIONS: { fetch: async () => Response.json(body, { status }) } },
    }));
  const target = { accountId, worker: "synthetic-pool" };
  await assert.rejects(
    sender(409, { error: "runtime-handoff-refused", reason: "unhealthy" })(
      "active-health",
      controllerCode,
      target,
      signingKey,
    ),
    ControllerRefused,
  );
  for (const [status, body] of [
    [500, { error: "runtime-defect" }],
    [401, { error: "unauthorized" }],
    [409, { error: "something-else" }],
  ] as const)
    await assert.rejects(
      sender(status, body)("active-health", controllerCode, target, signingKey),
      (error: unknown) => !(error instanceof ControllerRefused),
    );
});

test("a refused run list names its HTTP status and refuses apply", async () => {
  const { deps } = fakes({
    listRuns: async () => {
      throw new RunListRefused(403);
    },
  });
  const result = await runCrashDispatch(input(), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, "workflow run list unavailable (HTTP 403); apply refused");
});

test("a controller refusal of inspect publishes its fixed code, unlike an unknown failure", async () => {
  const { deps } = fakes({
    observe: async (action) => {
      if (action === "inspect") throw new ControllerRefused("inspect", "unhealthy");
      return { result: { action } };
    },
  });
  const result = await runCrashDispatch(
    input({ mode: "observe", packet: JSON.stringify({ controllerCode }) }),
    deps,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, "inspect outcome unknown: runtime-handoff-refused (unhealthy)");
});
