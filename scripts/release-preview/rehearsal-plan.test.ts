import assert from "node:assert/strict";
import { test } from "node:test";
import { runPreview } from "./lifecycle.ts";
import {
  rehearsalReceipt,
  rehearsalSteps,
  type ReleaseOutcome,
  type ReleaseRequest,
  type RehearsalHooks,
} from "./rehearsal-plan.ts";

const stopped: ReleaseOutcome = { ok: false, reason: "release-rehearsal-stopped-after-adopt" };
const drainDeadline: ReleaseOutcome = {
  ok: false,
  reason: "runtime-release-observation-deadline",
  worker: "PoolWorker.old-generation-drain",
};
const client = (name: string) => ({
  client: name,
  exit: 0,
  timeout: false,
  modelRequest: true,
  toolSearch: true,
  undo: true,
  revoke: true,
});
const smoke = {
  version: 1,
  mode: "preview",
  signIn: true,
  pool: true,
  cleanup: true,
  clients: [client("claude"), client("codex")],
};

function world(outcomes: ReleaseOutcome[], overrides: Partial<RehearsalHooks> = {}) {
  const events: string[] = [];
  const requests: ReleaseRequest[] = [];
  const hooks: RehearsalHooks = {
    deployBaseline: async () => void events.push("baseline"),
    seedPools: async () => (events.push("seed"), { cleanPool: "clean" }),
    verifyAdopted: async (pool) => void events.push(`adopted:${pool}`),
    settle: async () => void events.push("settle"),
    release: async (request) => {
      requests.push(request);
      events.push(`release:${request.candidate}`);
      return outcomes.shift() ?? { ok: true };
    },
    holdConnection: async () => (
      events.push("hold"),
      { close: async () => void events.push("close") }
    ),
    startTraffic: () => (
      events.push("traffic"),
      { stop: async () => (events.push("traffic-stop"), { ok: 12, failed: 0 }) }
    ),
    waits: async () => [
      { name: "old-generation-drain", outcome: "observed", milliseconds: 61_000 },
    ],
    serve: async () => (events.push("serve"), smoke),
    restart: async () => (
      events.push("restart"),
      {
        cellConcurrency: 4,
        siblingObserves: 3,
        signalToReadyMs: 30_000,
        servedWhileDown: 5,
        failedRequests: 0,
      }
    ),
    ...overrides,
  };
  return { hooks, events, requests };
}

const run = (steps: ReturnType<typeof rehearsalSteps>, events: string[]) =>
  runPreview({
    prepare: async () => {},
    deploy: steps.deploy,
    seed: steps.seed,
    smoke: steps.smoke as () => Promise<unknown>,
    destroy: async () => void events.push("destroy"),
    verifyAbsent: async () => void events.push("verify"),
  });

test("the straight rehearsal stops the previous candidate after adopt, then releases under traffic", async () => {
  const { hooks, events, requests } = world([stopped, { ok: true }]);
  const steps = rehearsalSteps("straight", hooks);
  assert.deepEqual(await run(steps, events), { smoke, teardown: true });
  assert.deepEqual(events, [
    "baseline",
    "seed",
    "release:previous",
    "adopted:clean",
    "settle",
    "traffic",
    "release:candidate",
    "traffic-stop",
    "serve",
    "restart",
    "destroy",
    "verify",
  ]);
  assert.deepEqual(requests[0], { candidate: "previous", stop: "after-adopt", cleanPool: "clean" });
  assert.deepEqual(requests[1], { candidate: "candidate", cleanPool: "clean" });
  const receipt = rehearsalReceipt(
    steps.record,
    { candidate: "a".repeat(40), previous: "b".repeat(40), stage: "test-rehearsal-11" },
    true,
  );
  assert.equal(receipt.releases.length, 2);
  assert.deepEqual(receipt.traffic, { ok: 12, failed: 0 });
  assert.equal(receipt.waits[0]!.milliseconds, 61_000);
});

test("the drain scenario times out with a held connection, then resumes the same candidate", async () => {
  const { hooks, events, requests } = world([stopped, drainDeadline, { ok: true }]);
  const steps = rehearsalSteps("drain-resume", hooks);
  await run(steps, events);
  assert.deepEqual(events.slice(5, 11), [
    "traffic",
    "hold",
    "release:candidate",
    "close",
    "release:candidate",
    "traffic-stop",
  ]);
  assert.equal(requests[1]!.drainCapMs, 120_000);
  assert.equal(requests[2]!.drainCapMs, undefined);
});

test("any unexpected outcome fails the rehearsal and still tears the stack down", async () => {
  const cases: Array<[string, ReleaseOutcome[], Partial<RehearsalHooks>, RegExp]> = [
    [
      "previous release went through",
      [{ ok: true }],
      {},
      /stop at release-rehearsal-stopped-after-adopt/,
    ],
    [
      "previous refused elsewhere",
      [{ ok: false, reason: "runtime-release-health-expired" }],
      {},
      /stop at/,
    ],
    [
      "candidate refused",
      [stopped, { ok: false, reason: "runtime-release-health-expired" }],
      {},
      /refused: runtime-release-health-expired/,
    ],
    [
      "a request failed",
      [stopped, { ok: true }],
      { startTraffic: () => ({ stop: async () => ({ ok: 3, failed: 1 }) }) },
      /failed during the release/,
    ],
    [
      "no request ran",
      [stopped, { ok: true }],
      { startTraffic: () => ({ stop: async () => ({ ok: 0, failed: 0 }) }) },
      /failed during the release/,
    ],
    [
      "drain never observed",
      [stopped, { ok: true }],
      { waits: async () => [] },
      /old-generation drain/,
    ],
  ];
  for (const [name, outcomes, overrides, error] of cases) {
    const { hooks, events } = world(outcomes, overrides);
    await assert.rejects(run(rehearsalSteps("straight", hooks), events), error, name);
    assert.deepEqual(events.slice(-2), ["destroy", "verify"], name);
  }
  const { hooks, events } = world([
    stopped,
    {
      ok: false,
      reason: "runtime-release-observation-deadline",
      worker: "PoolWorker.image-capacity",
    },
  ]);
  await assert.rejects(
    run(rehearsalSteps("drain-resume", hooks), events),
    /stop at runtime-release-observation-deadline/,
  );
  assert.ok(events.includes("close"), "a held connection is closed on failure");
});

test("a receipt needs exact commits and verified teardown", () => {
  const { record } = rehearsalSteps("straight", world([]).hooks);
  assert.throws(
    () =>
      rehearsalReceipt(record, { candidate: "main", previous: "b".repeat(40), stage: "s" }, true),
    /exact/,
  );
  assert.throws(
    () =>
      rehearsalReceipt(
        record,
        { candidate: "a".repeat(40), previous: "b".repeat(40), stage: "s" },
        false,
      ),
    /teardown/,
  );
});
