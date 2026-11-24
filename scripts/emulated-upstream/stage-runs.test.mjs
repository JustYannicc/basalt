// What deploy, check, destroy and the expiry decide on their own, and that no run prints the
// account's workers.dev hostname.
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { activeDispatches } from "./dispatch-busy.mjs";
import { countingText } from "./fixtures.mjs";
import { publicMessage } from "./public-error.mjs";
import { checkFailures, emulatedStage, LONG_MIN_MS, main, paced } from "./stage.mjs";

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
    async cf() {
      return { result: { subdomain: "acctsub" } };
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

const passing = () =>
  ["chat", "responses", "messages"].flatMap((shape) =>
    ["short", "long"].map((kind) => ({ shape, kind, pass: true })),
  );
const aimock401 = { status: 401, aimock: true };

test("a check passes only when every part does, and names each part that failed", () => {
  const ok = {
    worker401: [401, 401],
    refusal: { missing: aimock401, wrong: aimock401 },
    streams: passing(),
  };
  assert.deepEqual(checkFailures(ok), []);
  const streams = passing();
  streams[1] = { ...streams[1], pass: false, reason: "ended too soon" };
  streams[4] = { ...streams[4], pass: false, reason: "usage missing" };
  assert.deepEqual(
    checkFailures({
      worker401: [401, 200],
      refusal: { missing: aimock401, wrong: { status: 401, aimock: false } },
      streams,
    }),
    [
      "the Worker answered a call without the key",
      "the mock itself did not refuse a call without the right key",
      "chat long ended too soon",
      "messages short usage missing",
    ],
  );
  // Missing parts fail too: no refusal answer, fewer Worker calls or fewer streams.
  assert.deepEqual(checkFailures({ worker401: [401], refusal: {}, streams: passing().slice(1) }), [
    "the Worker answered a call without the key",
    "the mock itself did not refuse a call without the right key",
    "5 of 6 streams ran",
  ]);
});

const sse = (frames) => frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
const responsesStream = (content, output) =>
  sse([
    { type: "response.output_text.delta", delta: content },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 11, output_tokens: output } },
    },
  ]);

test("a check judges each stream by its shape and its pace on the clock", async () => {
  let clock = NOW;
  const api = fakeApi({ resources: deployed(), lease: NOW + hour });
  const answers = [];
  const fetcher = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/models") return new Response("{}", { status: 401 });
    if (pathname === "/_emulated/mock-refusal")
      return Response.json({ missing: aimock401, wrong: aimock401 });
    const long =
      JSON.parse(init.body).max_tokens === 4000 || JSON.parse(init.body).max_output_tokens === 4000;
    answers.push(pathname);
    // Only the responses shape answers, and its long stream comes back in 10 s.
    if (pathname !== "/v1/responses") return new Response("no", { status: 500 });
    clock += long ? 10_000 : 0;
    return new Response(long ? responsesStream(countingText, 3000) : responsesStream("OK", 2));
  };
  await assert.rejects(stageOf(api, { fetcher, now: () => clock }).check(), (error) => {
    assert.match(error.message, /responses long ended too soon/u);
    assert.match(error.message, /chat short status/u);
    assert.doesNotMatch(error.message, /responses short/u);
    return true;
  });
  assert.equal(answers.length, 6);
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
const unreachable =
  (reachable = []) =>
  async (url) => {
    const { hostname, pathname } = new URL(url);
    if (hostname === "api.cloudflare.com") {
      if (pathname.endsWith("/settings"))
        return Response.json({
          success: true,
          result: { bindings: [{ name: "DELETE_BY", text: String(NOW + hour) }] },
        });
      return Response.json({ success: true, result: { subdomain } });
    }
    if (reachable.includes(pathname)) return new Response("{}", { status: 401 });
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
        code: "ENOTFOUND",
        hostname,
      }),
    });
  };

test("a failing stage fetch prints no hostname, at the top level or in the summary", async () => {
  for (const reachable of [[], ["/v1/models"]]) {
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
        : /^The stage's unkeyed call failed \(TypeError\)$/u,
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
