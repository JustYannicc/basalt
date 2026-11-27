// What deploy, check, destroy and the expiry decide on their own, and that no run prints the
// account's workers.dev hostname.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { activeDispatches } from "./dispatch-busy.mjs";
import { gate, mockCalls } from "./gateway.ts";
import { SLOW_MS } from "./profile-check.mjs";
import { publicMessage } from "./public-error.mjs";
import { checkFailures, emulatedStage, keyedRoutes, LONG_MIN_MS, main, paced } from "./stage.mjs";
import { fakeAimock, memoryStore } from "./test/fake-aimock.mjs";
import { script } from "../stage-cloudflare/test/cloudflare-shapes.mjs";
import { fakeAccount } from "../stage-cloudflare/test/fake-account.mjs";

const worker = "basalt-emulated-upstream-gateway";
const hour = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 25, 12);
const none = () => ({ applications: [], scripts: [], namespaces: [], images: [] });

/** An account holding `resources`, whose Worker carries `lease`. */
function fakeApi({ resources = none(), lease } = {}) {
  const calls = [];
  return {
    calls,
    async inventory() {
      calls.push("inventory");
      return resources;
    },
    async lease(name) {
      calls.push(`lease ${name}`);
      return lease;
    },
    async destroy() {
      calls.push("destroy");
      return { before: resources, failures: [] };
    },
    async subdomain() {
      return "acctsub";
    },
    empty: (found) => Object.values(found).every((rows) => rows.length === 0),
    describe: (found) => found.scripts.map((row) => `Worker ${row.id}`).join(", "),
  };
}
const quiet = { summary: () => {}, save: () => {} };
const stageOf = (api, extra = {}) =>
  emulatedStage({ api, key: "k", now: () => NOW, ...quiet, deployEntry: () => {}, ...extra });
const deployed = () => ({ ...none(), scripts: [{ id: worker }] });

test("the expiry keeps a stage whose lease is still ahead, and touches nothing when none exists", async () => {
  const kept = fakeApi({ resources: deployed(), lease: NOW + hour });
  assert.equal(await stageOf(kept).expire(), "kept");
  assert.ok(!kept.calls.includes("destroy"));
  const empty = fakeApi();
  assert.equal(await stageOf(empty).expire(), "nothing");
  assert.deepEqual(empty.calls, ["inventory"]);
});

test("the expiry destroys a stage past its lease, without one, or without its Worker", async () => {
  for (const [label, api] of [
    ["lease passed", fakeApi({ resources: deployed(), lease: NOW - 1 })],
    ["lease ends now", fakeApi({ resources: deployed(), lease: NOW })],
    ["no lease", fakeApi({ resources: deployed(), lease: undefined })],
    [
      "no Worker",
      fakeApi({
        resources: { ...none(), applications: [{ name: "basalt-emulated-upstream-mock" }] },
        lease: NOW + hour,
      }),
    ],
  ]) {
    assert.equal(await stageOf(api).expire(), "destroyed", label);
    assert.ok(api.calls.includes("destroy"), label);
  }
  // A stage without its Worker is never asked for a lease it cannot have.
  const partial = fakeApi({
    resources: { ...none(), applications: [{ name: "basalt-emulated-upstream-mock" }] },
  });
  await stageOf(partial).expire();
  assert.ok(!partial.calls.some((call) => call.startsWith("lease")));
});

test("deploy refuses while the stage exists, before it records a start or runs the entry", async () => {
  const saved = [];
  let entry = 0;
  const api = fakeApi({ resources: deployed(), lease: NOW + hour });
  await assert.rejects(
    stageOf(api, { save: (name) => saved.push(name), deployEntry: () => entry++ }).deploy(),
    /already exists \(Worker basalt-emulated-upstream-gateway\); run destroy first/u,
  );
  assert.deepEqual(saved, []);
  assert.equal(entry, 0);
  assert.ok(!api.calls.includes("destroy"));
});

test("deploy on an empty account records the lease, runs the entry, then checks", async () => {
  const saved = {};
  let leased;
  const api = fakeApi();
  // The check then finds no lease (the fake entry deployed nothing) and refuses.
  await assert.rejects(
    stageOf(api, {
      save: (name, value) => (saved[name] = value),
      deployEntry: (deleteBy) => (leased = deleteBy),
      // The mock answers at once; nothing here leaves the test.
      fetcher: async () => new Response(null, { status: 200 }),
    }).deploy(),
    /is not deployed/u,
  );
  assert.equal(leased, NOW + 10 * hour);
  assert.deepEqual(saved["deploy-started"], {
    stage: "test-emulated-upstream",
    deleteBy: new Date(NOW + 10 * hour).toISOString(),
  });
});

test("a long stream must last at least 30 s; a short one may be quick", () => {
  assert.equal(LONG_MIN_MS, 30_000);
  assert.equal(paced(true, 29_999), false);
  assert.equal(paced(true, 30_000), true);
  assert.equal(paced(false, 5), true);
});

const passing = (kinds = ["short", "long"]) =>
  ["chat", "responses", "messages"].flatMap((shape) =>
    kinds.map((kind) => ({ shape, kind, pass: true })),
  );
const aimock401 = { status: 401, aimock: true };
const refused = () =>
  keyedRoutes.flatMap((path) =>
    ["unkeyed", "wrong-key"].map((who) => ({ call: `${who} ${path}`, status: 401 })),
  );
const profilesPassing = () => ({
  control: ["read", "slow", "limited", "restore"].map((step) => ({ step, status: 200 })),
  calls: [
    "via a",
    "unprefixed beside b's latency",
    "via b, slow",
    "via a beside b's 429",
    "unprefixed beside b's 429",
  ].map((kind) => ({
    shape: "messages",
    kind,
    pass: true,
  })),
  limited: { status: 429, retryAfter: "15", otherTimes: false, chaos: true },
});

test("a check passes only when every part does, and names each part that failed", () => {
  const ok = {
    worker401: refused(),
    refusal: { missing: aimock401, wrong: aimock401 },
    streams: passing(),
    wholes: passing(["non-streamed"]),
    profiles: profilesPassing(),
  };
  assert.deepEqual(checkFailures(ok), []);
  const streams = passing();
  streams[1] = { ...streams[1], pass: false, reason: "ended too soon" };
  streams[4] = { ...streams[4], pass: false, reason: "usage missing" };
  const worker401 = refused();
  worker401[3] = { ...worker401[3], status: 200 };
  const wholes = passing(["non-streamed"]);
  wholes[2] = { ...wholes[2], pass: false, reason: "content not exact" };
  const profiles = profilesPassing();
  profiles.control[3] = { step: "restore", status: 500 };
  profiles.calls[2] = {
    ...profiles.calls[2],
    pass: false,
    reason: "answered before profile b's latency",
  };
  profiles.limited = { status: 429, retryAfter: "1", otherTimes: true, chaos: false };
  assert.deepEqual(
    checkFailures({
      worker401,
      refusal: { missing: aimock401, wrong: { status: 401, aimock: false } },
      streams,
      wholes,
      profiles,
    }),
    [
      "the Worker answered wrong-key /a/v1/models with HTTP 200",
      "the mock itself did not refuse a call without the right key",
      "chat long ended too soon",
      "messages short usage missing",
      "messages non-streamed content not exact",
      "profile b restore: HTTP 500",
      "messages via b, slow answered before profile b's latency",
      "profile b's 429 carried Retry-After 1, not 15",
      "profile b's 429 carried aimock's own reset headers",
      "profile b's 429 was not aimock's chaos answer",
    ],
  );
  // Missing parts fail too: no refusal answer, fewer calls, or a profile proof that stopped.
  assert.deepEqual(
    checkFailures({
      worker401: refused().slice(1),
      refusal: {},
      streams: passing().slice(1),
      wholes: [],
      profiles: { control: [{ step: "read", status: 200 }], calls: [], failure: "it stopped" },
    }),
    [
      "7 of 8 calls without the right key ran",
      "the mock itself did not refuse a call without the right key",
      "5 of 6 streams ran",
      "0 of 3 non-streamed calls ran",
      "profile check: it stopped",
      "profile b slow: HTTP -",
      "profile b limited: HTTP -",
      "profile b restore: HTTP -",
      "0 of 5 profile calls ran",
      "messages via b at a 429 share of 1: HTTP -",
    ],
  );
  assert.deepEqual(checkFailures({ ...ok, profiles: undefined }), [
    "the profile check did not run",
  ]);
});

/**
 * The deployed stage: the Worker's own gate, profiles and control, in front of a stand-in that
 * answers like aimock. Every call carries the clock forward by what the mock would take.
 */
function deployedStage({ key = "k", store = memoryStore(), start, ...mock } = {}) {
  const clock = { ms: NOW };
  const aimock = fakeAimock({ key, clock, ...mock });
  const answer = mockCalls({ store, key, start: start ?? (async () => aimock.port) });
  const fetcher = (url, init) => gate(new Request(url, init), key, answer);
  return { aimock, clock, store, fetcher, key };
}

test("a check through the Worker's gate and profiles passes, and puts profile b back as it found it", async () => {
  const running = { rateLimitRate: 0.25, latencyMs: 7000 };
  const stage = deployedStage({ store: memoryStore(running) });
  const saved = {};
  await stageOf(fakeApi({ resources: deployed(), lease: NOW + hour }), {
    key: stage.key,
    fetcher: stage.fetcher,
    now: () => stage.clock.ms,
    save: (name, value) => (saved[name] = value),
  }).check();
  assert.deepEqual(stage.store.value, running);
  const { profiles } = saved.check;
  assert.deepEqual(
    profiles.control.map((row) => [row.step, row.status]),
    [
      ["read", 200],
      ["slow", 200],
      ["limited", 200],
      ["restore", 200],
    ],
  );
  assert.deepEqual(profiles.limited, {
    status: 429,
    retryAfter: "15",
    otherTimes: false,
    chaos: true,
  });
  assert.ok(profiles.calls.find((row) => row.kind === "via b, slow").ms >= SLOW_MS);
  assert.ok(saved.check.wholes.every((row) => row.pass && row.kind === "non-streamed"));
  assert.ok(saved.check.worker401.every((row) => row.status === 401));
  // Only the profile calls reached the mock with chaos set, and only b's carried any.
  const profiled = stage.aimock.calls.filter((call) => Object.keys(call.chaos).length);
  assert.deepEqual(
    profiled
      .map((call) => [call.chaos["x-aimock-chaos-ratelimit"], call.chaos["x-aimock-chaos-latency"]])
      .sort(),
    [
      ["0", "0"],
      ["0", "0"],
      ["0", String(SLOW_MS)],
      ["1", "0"],
    ],
  );
  assert.ok(profiled.every((call) => call.path === "/v1/messages"));
});

test("a check names a burst stream, a latency or 429 share the mock never saw, and still puts b back", async () => {
  // The three long streams run at once on one clock: 5 s each is still 15 s in all, a burst.
  const stage = deployedStage({ chaos: false, longMs: 5_000 });
  await assert.rejects(
    stageOf(fakeApi({ resources: deployed(), lease: NOW + hour }), {
      key: stage.key,
      fetcher: stage.fetcher,
      now: () => stage.clock.ms,
    }).check(),
    (error) => {
      for (const shape of ["chat", "responses", "messages"])
        assert.match(error.message, new RegExp(`${shape} long ended too soon`, "u"));
      assert.match(error.message, /messages via b, slow answered before profile b's latency/u);
      assert.match(error.message, /messages via b at a 429 share of 1: HTTP 200/u);
      assert.doesNotMatch(error.message, /short|non-streamed|via a|restore|Worker answered/u);
      return true;
    },
  );
  assert.deepEqual(stage.store.value, { rateLimitRate: 0, latencyMs: 0 });
});

test("a check refuses past the lease without calling the stage", async () => {
  let called = false;
  const fetcher = async () => {
    called = true;
    return new Response("");
  };
  await assert.rejects(
    stageOf(fakeApi({ resources: deployed(), lease: NOW }), { fetcher }).check(),
    /lease ended at 2026-11-25T12:00:00.000Z/u,
  );
  assert.equal(called, false);
});

const dispatch = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  EMULATED_STAGE: "test-emulated-upstream",
  EMULATED_MODE: "check",
  EMULATED_GO: "coordinator-2026-11-25-load-proof-1",
  EMULATED_UPSTREAM_KEY: "k".repeat(43),
  CLOUDFLARE_ACCOUNT_ID: "acct",
  CLOUDFLARE_API_TOKEN: "t",
};
const subdomain = "acct-secret-sub";
/** The account answers the lease and the subdomain; every call to the stage fails like undici. */
const leased = fakeAccount({
  live: { scripts: [script(worker)] },
  bindings: { [worker]: { DELETE_BY: String(NOW + hour) } },
  workersSubdomain: subdomain,
});
const unreachable =
  (reachable = []) =>
  async (url, init) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === "api.cloudflare.com") return leased.fetcher(url, init);
    if (reachable.includes(pathname)) return new Response("{}", { status: 401 });
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: "ENOTFOUND",
        hostname,
      }),
    });
  };

test("a failing stage fetch prints no hostname, at the top level or in the summary", async () => {
  for (const reachable of [[], keyedRoutes]) {
    const printed = [];
    const code = await main(dispatch, {
      fetcher: unreachable(reachable),
      now: () => NOW,
      error: (line) => printed.push(line),
      summary: (line) => printed.push(line),
      save: (name, value) => printed.push(JSON.stringify(value)),
      deployEntry: () => {},
    });
    assert.equal(code, 1);
    assert.ok(printed.length > 0);
    for (const line of printed) {
      assert.doesNotMatch(line, new RegExp(`${subdomain}|workers\\.dev|ENOTFOUND`, "u"), line);
    }
    assert.match(
      printed.at(-1),
      reachable.length
        ? /^Emulated upstream check failed: the mock itself did not refuse.*chat short The stage's chat short stream call failed \(TypeError\)/u
        : /^The stage's unkeyed \/v1\/models call failed \(TypeError\)$/u,
    );
  }
  // Any error not raised by this stage prints as its kind only.
  const raw = new TypeError(`fetch failed for ${worker}.${subdomain}.workers.dev`);
  assert.doesNotMatch(publicMessage(raw), /workers\.dev/u);
  assert.doesNotMatch(inspect(publicMessage(raw)), /workers\.dev/u);
});

test("a refused guard prints only its token", async () => {
  const printed = [];
  const code = await main(
    { ...dispatch, EMULATED_STAGE: "production" },
    {
      error: (line) => printed.push(line),
      fetcher: () => assert.fail("no call may run"),
    },
  );
  assert.equal(code, 1);
  assert.deepEqual(printed, ["emulated_upstream_stage_refused"]);
});

test("the expiry skips while a recent dispatched run on main is not completed, and fails closed on an odd listing", () => {
  const now = Date.parse("2026-11-25T12:00:00Z");
  const run = (id, status, extra = {}) => ({
    id,
    event: "workflow_dispatch",
    status,
    head_branch: "main",
    created_at: "2026-11-25T11:30:00Z",
    ...extra,
  });
  assert.deepEqual(activeDispatches({ workflow_runs: [] }, now), []);
  assert.deepEqual(
    activeDispatches(
      {
        workflow_runs: [
          run(1, "completed"),
          { ...run(2, "in_progress"), event: "schedule" },
          run(3, "queued"),
          run(4, "in_progress"),
          run(5, "waiting"),
          run("x", "https://example.invalid"),
          run(6, "queued", { head_branch: "feature" }),
          run(7, "waiting", { created_at: "2026-11-24T12:00:00Z" }),
          run(8, "queued", { created_at: undefined }),
        ],
      },
      now,
    ),
    [
      { id: 3, status: "queued" },
      { id: 4, status: "in_progress" },
      { id: 5, status: "waiting" },
      { id: "unknown", status: "unknown" },
      { id: 8, status: "queued" },
    ],
  );
  for (const body of [undefined, {}, { workflow_runs: {} }])
    assert.throws(() => activeDispatches(body), /answered without its runs/u);
});

// The platform's answer to a Durable Object that asks for its container too soon after a deploy.
const noInstance =
  "There is no container instance that can be provided to this Durable Object, try again later";

test("a deploy waits for the platform to start the mock, then checks", async () => {
  let refused = 3;
  const stage = deployedStage({
    start: async () => {
      if (refused-- > 0) throw new Error(noInstance);
      return stage.aimock.port;
    },
  });
  const lines = [];
  await stageOf(fakeApi({ lease: NOW + hour }), {
    key: stage.key,
    fetcher: stage.fetcher,
    now: () => stage.clock.ms,
    wait: async (ms) => (stage.clock.ms += ms),
    summary: (line) => lines.push(line),
  }).deploy();
  assert.ok(
    lines.includes("- the mock answered 15 s after the deploy (bound 120 s)"),
    lines.join("\n"),
  );
});

test("a mock the platform never starts fails the deploy with the platform's own reason", async () => {
  const saved = {};
  const stage = deployedStage({
    start: async () => {
      throw new Error(noInstance);
    },
  });
  await assert.rejects(
    stageOf(fakeApi({ lease: NOW + hour }), {
      key: stage.key,
      fetcher: stage.fetcher,
      now: () => stage.clock.ms,
      wait: async (ms) => (stage.clock.ms += ms),
      save: (name, value) => (saved[name] = value),
    }).deploy(),
    new RegExp(`did not answer within 120 s of the deploy: ${noInstance}$`, "u"),
  );
  // The start was recorded, so the workflow's teardown after a failed deploy removes the stage.
  assert.ok(saved["deploy-started"]);
});

test("a start failure that is not plain words reaches no caller", async () => {
  const stage = deployedStage({
    start: async () => {
      throw new Error("failed at https://host.example/x for 0123456789abcdef0123456789abcdef");
    },
  });
  await assert.rejects(
    stageOf(fakeApi({ lease: NOW + hour }), {
      key: stage.key,
      fetcher: stage.fetcher,
      now: () => stage.clock.ms,
      wait: async (ms) => (stage.clock.ms += ms),
    }).deploy(),
    /did not answer within 120 s of the deploy: an unrecognised start failure$/u,
  );
});
