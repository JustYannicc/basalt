import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ProviderObservationRefused } from "../src/pool/runtime-provider/read.ts";
import { providerObservationFailureHeader } from "../src/pool/runtime-provider/observation.ts";
import { runtimeErrorResponse } from "../src/pool/runtime-slots/request-error.ts";
import { SlotRefused } from "../src/pool/runtime-slots/contract.ts";
import { deploymentReadinessPrefix } from "../src/pool/deployment-readiness.ts";
import { openEnvelope } from "../src/pool/token.ts";
import { providerTarget, readReleaseTarget } from "./pool-crash-dispatch-sources.ts";
import {
  logLine,
  observeLimitMs,
  observeSender,
  recoveryResetSender,
  runCrashDispatch,
  type DispatchDependencies,
  type DispatchInput,
} from "./pool-crash-dispatch.ts";
import { sendRuntimeCommand } from "./pool-fleet/runtime-command-rpc.ts";
import { accountId, harness, primary, worker } from "./pool-fleet/test/harness.ts";
import { resolvedApplication } from "./pool-fleet/test/cloudflare-shapes.ts";

const controllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
const reads = "provider observation: reads";
const closedLine =
  /^provider observation: (reads|does not read \((provider_observation_refused|provider_fetch_failed|controller_identity|controller_refused|reply_unreadable|no_reply|bridge_failed|response_refused|outcome_unknown|target_unavailable)\))$/u;
// Distinct from every other identity in the run, so any appearance in the output came from this read.
const pins = {
  accountId,
  applicationId: "provider-application-sentinel",
  namespaceId: "provider-namespace-sentinel",
  applicationVersion: "991",
  imageDigest: `sha256:${"7".repeat(64)}`,
  applicationConfigDigest: "8".repeat(64),
};
const observationDigest = "9".repeat(64);
const observation = (proof: Partial<typeof pins> = {}) => ({
  credentialBinding: "POOL_PROVIDER_OBSERVATION_TOKEN",
  proof: { ...pins, ...proof, observationDigest, observedAt: 1_700_000_000_000 },
});
const sentinels = [
  pins.applicationId,
  pins.namespaceId,
  pins.imageDigest,
  pins.applicationConfigDigest,
  observationDigest,
  "1700000000000",
  "body-sentinel",
  "header-sentinel",
];

const input = (signingKey = randomBytes(32).toString("hex")): DispatchInput => ({
  mode: "observe",
  requestId: crypto.randomUUID(),
  packet: JSON.stringify({ controllerCode }),
  coordinatorGo: "GO observe the provider",
  accountId,
  signingKey,
  ref: "refs/heads/main",
  event: "workflow_dispatch",
  runId: 7,
  runAttempt: "1",
});

/** Every existing observe read answers fixed replies; only provider-observe varies between runs. */
function world(provider: typeof pins | undefined, observe: DispatchDependencies["observe"]) {
  const sent: string[] = [];
  const deps: DispatchDependencies = {
    listRuns: async () => [],
    readTarget: async () => ({
      accountId,
      worker: "synthetic-pool",
      ...(provider ? { provider } : {}),
    }),
    rootHealth: async () => {
      throw new Error("root health unavailable");
    },
    resetRecovery: async () => {
      throw new Error("observe never resets recovery");
    },
    sleep: async () => {},
    observe: async (action, ...rest) => {
      sent.push(action);
      if (action === "provider-observe") return observe(action, ...rest);
      return { result: action === "inspect" ? { selection: { slot: "primary" } } : { action } };
    },
    crash: async () => {
      throw new Error("observe never crashes");
    },
    now: () => 1,
  };
  return { deps, sent };
}

/** observeSender over a bridge answering provider-observe with one fixed response. */
const answering = (respond: () => Response | Promise<Response>) =>
  observeSender(async () => ({
    dispose: async () => {},
    env: { POOL_OPERATIONS: { fetch: async () => respond() } },
  }));

test("the provider target is the live root application's pins, through the controller's decoder", async () => {
  const raw = {
    ...structuredClone(resolvedApplication),
    id: "root-app",
    account_id: accountId,
    version: 57,
    configuration: { ...resolvedApplication.configuration, image: `r/pool@${pins.imageDigest}` },
    durable_objects: { namespace_id: "ns-root" },
  };
  const target = providerTarget(raw, accountId);
  assert.deepEqual(Object.keys(target ?? {}).sort(), Object.keys(pins).sort());
  assert.deepEqual(
    { ...target, applicationConfigDigest: undefined },
    {
      accountId,
      applicationId: "root-app",
      namespaceId: "ns-root",
      applicationVersion: "57",
      imageDigest: pins.imageDigest,
      applicationConfigDigest: undefined,
    },
  );
  assert.match(target!.applicationConfigDigest, /^[a-f0-9]{64}$/u);
  // The controller refuses each of these, so no target is built and nothing is sent.
  const configuration = (image: string) => ({ ...raw.configuration, image });
  for (const refused of [
    { ...raw, active_rollout_id: "rollout" },
    { ...raw, durable_objects: null },
    { ...raw, configuration: configuration("r/pool:latest") },
    { ...raw, account_id: "b".repeat(32) },
    { ...raw, unexpected: true },
  ])
    assert.equal(providerTarget(refused, accountId), undefined);
});

test("a bound provider secret reads, end to end through the controller's handler", async () => {
  const lane = await harness();
  try {
    const target = await readReleaseTarget(
      {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "fixture-token",
        POOL_DEPLOYMENT_KEY: lane.signingKey,
      },
      { origin: lane.cloudflareOrigin, connect: lane.connect, code: lane.code },
    );
    assert.equal(target.worker, worker);
    assert.equal(target.provider?.applicationId, primary.applicationId);
    assert.equal(target.provider?.namespaceId, "ns-root");
    const before = structuredClone([...lane.storage.values]);
    const real = observeSender(lane.connect);
    const run = world(target.provider, real);
    const result = await runCrashDispatch(
      { ...input(lane.signingKey), packet: JSON.stringify({ controllerCode: lane.code }) },
      { ...run.deps, readTarget: async () => target },
    );
    assert.equal(result.providerObservation, reads);
    assert.ok(logLine(result).includes(`\n${reads}\n`));
    // (b) The Worker side: one GET of the root application with its own binding, no instance
    // list, and the controller's storage exactly as before.
    assert.deepEqual(lane.providerRequests, [
      `GET /client/v4/accounts/${accountId}/containers/applications/${primary.applicationId}`,
    ]);
    assert.deepEqual([...lane.storage.values], before);
    assert.deepEqual(lane.actions, ["inspect", "provider-observe"]);
  } finally {
    await lane.close();
  }
});

test("an empty provider secret is the Worker's own refusal, read from its failure header", async () => {
  const lane = await harness({ providerSecret: null });
  try {
    const target = await readReleaseTarget(
      {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "fixture-token",
        POOL_DEPLOYMENT_KEY: lane.signingKey,
      },
      { origin: lane.cloudflareOrigin, connect: lane.connect, code: lane.code },
    );
    const run = world(target.provider, observeSender(lane.connect));
    const result = await runCrashDispatch(
      { ...input(lane.signingKey), packet: JSON.stringify({ controllerCode: lane.code }) },
      { ...run.deps, readTarget: async () => target },
    );
    assert.equal(
      result.providerObservation,
      "provider observation: does not read (provider_observation_refused)",
    );
    // An empty secret never reaches the provider.
    assert.deepEqual(lane.providerRequests, []);
  } finally {
    await lane.close();
  }
});

test("(a) every outcome publishes one closed line and nothing else from the read", async () => {
  const refusal = (error: unknown) => {
    const response = runtimeErrorResponse(error, "handoff");
    response.headers.set("x-private", "header-sentinel");
    return response;
  };
  const cases: [string, DispatchDependencies["observe"] | undefined][] = [
    ["reads", async () => ({ result: observation() })],
    [
      "provider_observation_refused",
      answering(() => refusal(new ProviderObservationRefused("provider_observation_refused"))),
    ],
    [
      "provider_fetch_failed",
      answering(() => refusal(new ProviderObservationRefused("provider_fetch_failed"))),
    ],
    // The handoff refuses other controller code, or a command it cannot decode, as identity.
    ["controller_identity", answering(() => refusal(new SlotRefused("identity")))],
    ["controller_refused", answering(() => refusal(new SlotRefused("selection")))],
    // A 409 that claims a provider cause in its body but lacks the header is not the Worker's cause.
    [
      "controller_refused",
      answering(() =>
        Response.json(
          { error: "runtime-handoff-refused", reason: "provider_fetch_failed" },
          { status: 409 },
        ),
      ),
    ],
    // Any answer but a 200 or the handoff's own 409, here a defect: the Worker answered, not the provider.
    [
      "response_refused",
      answering(() =>
        Response.json(
          { error: "runtime-defect", detail: "body-sentinel" },
          { status: 500, headers: { [providerObservationFailureHeader]: "provider_fetch_failed" } },
        ),
      ),
    ],
    // No answer within the request's own time limit.
    [
      "no_reply",
      async () => {
        throw new DOMException("Operation aborted", "AbortError");
      },
    ],
    // The Node bridge's own fixed failures.
    [
      "bridge_failed",
      async () => {
        throw new Error("Private operations Node bridge exited");
      },
    ],
    [
      "outcome_unknown",
      async () => {
        throw new Error("lost reply naming body-sentinel");
      },
    ],
    ["reply_unreadable", async () => ({ nothing: "body-sentinel" })],
    ["reply_unreadable", async () => ({ result: { proof: "body-sentinel" } })],
    ["reply_unreadable", async () => ({ result: observation({ namespaceId: "other" }) })],
    ["target_unavailable", undefined],
  ];
  const baseline = await runCrashDispatch(input(), world(undefined, async () => ({})).deps);
  const { providerObservation: _baseline, restartObservation: _none, ...unchanged } = baseline;
  for (const [cause, observe] of cases) {
    const run = world(observe ? pins : undefined, observe ?? (async () => ({})));
    const result = await runCrashDispatch(input(), run.deps);
    const line = cause === "reads" ? reads : `provider observation: does not read (${cause})`;
    assert.equal(result.providerObservation, line, cause);
    assert.match(result.providerObservation ?? "", closedLine);
    assert.equal(run.sent.includes("provider-observe"), observe !== undefined, cause);
    // The rest of the result is exactly what the observe published before this read existed.
    const { providerObservation: _line, restartObservation: _restart, ...rest } = result;
    assert.deepEqual({ ...rest, requestId: baseline.requestId }, unchanged, cause);
    const published = JSON.stringify(result) + logLine(result);
    for (const sentinel of sentinels)
      assert.ok(!published.includes(sentinel), `${cause} ${sentinel}`);
    assert.ok(logLine(result).includes(`\n${line}\n`), cause);
  }
});

test("(b) observe signs only read commands, and the provider read carries exactly the six pins", async () => {
  const signingKey = randomBytes(32).toString("hex");
  const commands: Record<string, unknown>[] = [];
  const sender = observeSender(async () => ({
    dispose: async () => {},
    env: {
      POOL_OPERATIONS: {
        fetch: async (request: Request) => {
          assert.equal(request.method, "POST");
          const { envelope } = (await request.json()) as { envelope: string };
          const command = (await openEnvelope(signingKey, deploymentReadinessPrefix, envelope)) as {
            action: string;
          };
          commands.push(command);
          if (command.action === "provider-observe")
            return Response.json({ result: observation() });
          return Response.json({
            result: command.action === "inspect" ? { selection: null } : { action: command.action },
          });
        },
      },
    },
  }));
  const root = {
    applicationId: "root-application",
    applicationVersion: "57",
    imageDigest: pins.imageDigest,
    imageInput: "root-input",
  };
  const result = await runCrashDispatch(input(signingKey), {
    ...world(pins, sender).deps,
    readTarget: async () => ({ accountId, worker: "synthetic-pool", root, provider: pins }),
    rootHealth: async () => ({
      instanceId: "f".repeat(64),
      imageHash: "h",
      running: true,
      ready: true,
    }),
    observe: sender,
  });
  assert.equal(result.ok, true);
  assert.equal(result.providerObservation, reads);
  // No crash, inspect-crash, stage, adopt, promote or fleet write is ever signed in observe mode.
  assert.deepEqual(
    commands.map((command) => command.action),
    ["provider-observe", "inspect", "fleet-inspect", "active-health", "witness", "inspect"],
  );
  const provider = commands.find((command) => command.action === "provider-observe")!;
  assert.deepEqual(Object.keys(provider).sort(), [
    "action",
    "at",
    "controllerCode",
    "expiresAt",
    "target",
  ]);
  assert.deepEqual(provider.target, pins);
  // The closed command union refuses a subject the action does not carry, before any send.
  const before = commands.length;
  const slot = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "1".repeat(64),
    instanceId: "1".repeat(64),
    slotId: "legacy",
    applicationId: "a",
    applicationVersion: "1",
    imageDigest: pins.imageDigest,
    imageInput: "i",
  };
  const target = { accountId, worker: "synthetic-pool" };
  await assert.rejects(sender("provider-observe", controllerCode, target, signingKey, slot));
  await assert.rejects(sender("witness", controllerCode, target, signingKey, pins));
  await assert.rejects(
    sender("provider-observe", controllerCode, target, signingKey, {
      ...pins,
      imageInput: "i",
    } as never),
  );
  assert.equal(commands.length, before);
});

const restartLine =
  /^restart read: (passes|refuses \(recorded_pins_differ\)|does not read \([a-z_]+\)|not checked \((selection_unavailable|no_selected_runtime|selection_unreadable|selected_runtime_not_root|target_unavailable)\))$/u;

/** An observe whose inspect reports this selection; every other read is the fixed world's. */
function selected(
  provider: typeof pins | undefined,
  observe: DispatchDependencies["observe"],
  selection: unknown,
) {
  const run = world(provider, observe);
  const fixed = run.deps.observe;
  run.deps.observe = async (action, ...rest) =>
    action === "inspect"
      ? (run.sent.push(action), { result: { selection } })
      : fixed(action, ...rest);
  return run;
}

test("(c) the restart read sends the selection's recorded pins, and names drift apart from the token", async () => {
  const lane = await harness();
  try {
    const target = await readReleaseTarget(
      {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "fixture-token",
        POOL_DEPLOYMENT_KEY: lane.signingKey,
      },
      { origin: lane.cloudflareOrigin, connect: lane.connect, code: lane.code },
    );
    const { bootId: _boot, ...recorded } = primary;
    const before = structuredClone([...lane.storage.values]);
    const observe = async (selection: unknown) => {
      const requests = lane.providerRequests.length;
      const run = selected(target.provider, observeSender(lane.connect), selection);
      const result = await runCrashDispatch(
        { ...input(lane.signingKey), packet: JSON.stringify({ controllerCode: lane.code }) },
        { ...run.deps, readTarget: async () => target },
      );
      assert.match(result.restartObservation ?? "", restartLine);
      assert.ok(logLine(result).endsWith(`\n${result.restartObservation}\n`));
      return {
        token: result.providerObservation,
        restart: result.restartObservation,
        reads: lane.providerRequests.length - requests,
      };
    };
    const active = (slot: object) => ({ active: { target: slot } });
    // The recorded pins are the live ones: the Worker reads them twice with its own binding.
    assert.deepEqual(await observe(active(recorded)), {
      token: reads,
      restart: "restart read: passes",
      reads: 2,
    });
    // The runtime was admitted against another version or image: the Worker reads the application
    // and refuses the comparison, so the token reads, the restart would not, and the line says which.
    for (const drift of [{ applicationVersion: "56" }, { imageDigest: `sha256:${"5".repeat(64)}` }])
      assert.deepEqual(await observe(active({ ...recorded, ...drift })), {
        token: reads,
        restart: "restart read: refuses (recorded_pins_differ)",
        reads: 2,
      });
    // Nothing selected, a selection this read cannot decode, or one on another application: no
    // second read is sent, and the line says it was not checked.
    for (const [selection, cause] of [
      [null, "no_selected_runtime"],
      [{ active: {} }, "selection_unreadable"],
      [active({ ...recorded, applicationId: "app-blue" }), "selected_runtime_not_root"],
    ] as const)
      assert.deepEqual(
        await observe(selection),
        { token: reads, restart: `restart read: not checked (${cause})`, reads: 1 },
        cause,
      );
    assert.deepEqual([...lane.storage.values], before);
  } finally {
    await lane.close();
  }
});

test("(c) the restart read's command is the live pins with only the recorded version and image", async () => {
  const targets: unknown[] = [];
  const recorded = {
    format: "pool-runtime-slot-v1",
    controllerId: "1".repeat(64),
    instanceId: "1".repeat(64),
    slotId: "legacy",
    applicationId: pins.applicationId,
    applicationVersion: "990",
    imageDigest: `sha256:${"6".repeat(64)}`,
    imageInput: "i",
  };
  const run = selected(
    pins,
    async (_action, _code, _target, _key, subject) => {
      targets.push(subject);
      return { result: observation(subject as Partial<typeof pins>) };
    },
    { active: { target: recorded } },
  );
  const result = await runCrashDispatch(input(), run.deps);
  assert.equal(result.restartObservation, "restart read: passes");
  assert.deepEqual(targets, [
    pins,
    { ...pins, applicationVersion: "990", imageDigest: recorded.imageDigest },
  ]);
  // The log carries the two closed lines and no pin.
  const published = logLine(result);
  assert.ok(published.endsWith(`\n${reads}\nrestart read: passes\n`));
  for (const sentinel of [...sentinels, recorded.imageDigest])
    assert.ok(!published.includes(sentinel), sentinel);
});

test("(d) a packet for other controller code reads as the Worker refusing its identity, not the token", async () => {
  const lane = await harness();
  try {
    const target = await readReleaseTarget(
      {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_API_TOKEN: "fixture-token",
        POOL_DEPLOYMENT_KEY: lane.signingKey,
      },
      { origin: lane.cloudflareOrigin, connect: lane.connect, code: lane.code },
    );
    const { bootId: _boot, ...recorded } = primary;
    const run = selected(target.provider, observeSender(lane.connect), {
      active: { target: recorded },
    });
    const stale = { ...lane.code, candidate: "e".repeat(40) };
    const result = await runCrashDispatch(
      { ...input(lane.signingKey), packet: JSON.stringify({ controllerCode: stale }) },
      { ...run.deps, readTarget: async () => target },
    );
    assert.equal(
      result.providerObservation,
      "provider observation: does not read (controller_identity)",
    );
    assert.equal(result.restartObservation, "restart read: does not read (controller_identity)");
    // The Worker refused before any provider read.
    assert.deepEqual(lane.providerRequests, []);
  } finally {
    await lane.close();
  }
});

test("(e) an inspect that fails after the token read names line 2 and keeps a closed cause", async () => {
  for (const [label, failure, error] of [
    [
      "no reply in time",
      new DOMException("Operation aborted", "AbortError"),
      "inspect outcome unknown: AbortError",
    ],
    [
      "the bridge exited",
      new Error("Private operations Node bridge exited"),
      "inspect outcome unknown: bridge exited",
    ],
    [
      "the bridge never started",
      new Error("Private operations Node bridge startup timed out"),
      "inspect outcome unknown: bridge startup timed out",
    ],
    // Anything else keeps only the phase: its message is not closed text.
    ["anything else", new Error("lost reply naming body-sentinel"), "inspect outcome unknown"],
  ] as const) {
    const run = world(pins, async () => ({ result: observation() }));
    const fixed = run.deps.observe;
    run.deps.observe = async (action, ...rest) => {
      if (action !== "inspect") return fixed(action, ...rest);
      run.sent.push(action);
      throw failure;
    };
    const result = await runCrashDispatch(input(), run.deps);
    assert.equal(result.ok, false, label);
    assert.equal(result.providerObservation, reads, label);
    assert.equal(
      result.restartObservation,
      "restart read: not checked (selection_unavailable)",
      label,
    );
    assert.equal(result.error, error, label);
    assert.ok(
      logLine(result).endsWith(`\n${reads}\nrestart read: not checked (selection_unavailable)\n`),
      label,
    );
    assert.ok(!(JSON.stringify(result) + logLine(result)).includes("body-sentinel"), label);
  }
});

test("(f) a reply the shared RPC refuses carries its HTTP status and nothing else from it", async () => {
  const run = world(pins, async () => ({ result: observation() }));
  const fixed = run.deps.observe;
  const unavailable = answering(
    () => new Response(JSON.stringify({ detail: "body-sentinel" }), { status: 503 }),
  );
  run.deps.observe = async (action, ...rest) =>
    action === "inspect" ? unavailable(action, ...rest) : fixed(action, ...rest);
  const result = await runCrashDispatch(input(), run.deps);
  assert.equal(
    result.error,
    "inspect outcome unknown: runtime-handoff-response-refused (PoolRuntime) HTTP 503",
  );
  assert.equal(result.restartObservation, "restart read: not checked (selection_unavailable)");
  assert.ok(!JSON.stringify(result).includes("body-sentinel"));
});

test("(f) an observe read waits 30 s for its answer; any other command keeps 15 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The bridge's close removes a temporary directory: real file I/O over several loop turns.
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  // Bounded by real time (setTimeout is mocked): long enough for the close, never a hang.
  const drain = async (state: () => string, ms: number) => {
    const end = performance.now() + ms;
    while (state() === "pending" && performance.now() < end) await turn();
  };
  /** A bridge whose answer never comes: its request fails only when the client gives up. */
  const hung = () => {
    let sent!: () => void;
    const started = new Promise<void>((resolve) => (sent = resolve));
    // A Request follows its caller's signal only while it is reachable; a real bridge holds it in
    // its pending call, and so does this one.
    const held: Request[] = [];
    const connect = async () => ({
      dispose: async () => {},
      env: {
        POOL_OPERATIONS: {
          fetch: (request: Request) =>
            new Promise<Response>((_, reject) => {
              held.push(request);
              sent();
              request.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Operation aborted", "AbortError")),
                { once: true },
              );
            }),
        },
      },
    });
    return { started, connect };
  };
  const settled = (promise: Promise<unknown>) => {
    let state = "pending";
    promise.then(
      () => (state = "answered"),
      (error: unknown) => (state = error instanceof DOMException ? error.name : String(error)),
    );
    return () => state;
  };
  const signingKey = randomBytes(32).toString("hex");
  const target = { accountId, worker: "synthetic-pool" };
  assert.equal(observeLimitMs, 30_000);
  const read = hung();
  const observed = settled(
    observeSender(read.connect)("inspect", controllerCode, target, signingKey),
  );
  await read.started;
  t.mock.timers.tick(15_001);
  await drain(observed, 250);
  assert.equal(observed(), "pending", "a read is still waiting after 15 s");
  t.mock.timers.tick(15_000);
  await drain(observed, 5_000);
  assert.equal(observed(), "AbortError", "a read gives up after 30 s");
  // The shared RPC's own limit, which every mutating command uses, stays 15 s.
  const write = hung();
  const at = Date.now() - 2_000;
  const mutating = settled(
    sendRuntimeCommand(
      { controllerCode, action: "inspect", at, expiresAt: at + 25_000 },
      signingKey,
      { ...target, connect: write.connect },
      () => {},
    ),
  );
  await write.started;
  t.mock.timers.tick(15_001);
  await drain(mutating, 5_000);
  assert.equal(mutating(), "AbortError", "the default limit is 15 s");
  // A recovery reset writes, so it keeps 15 s too.
  const reset = hung();
  const resetting = settled(
    recoveryResetSender(reset.connect)(
      controllerCode,
      target,
      signingKey,
      `recovery-reset-${crypto.randomUUID()}`,
    ),
  );
  await reset.started;
  t.mock.timers.tick(15_001);
  await drain(resetting, 5_000);
  assert.equal(resetting(), "AbortError", "a recovery reset keeps 15 s");
});
