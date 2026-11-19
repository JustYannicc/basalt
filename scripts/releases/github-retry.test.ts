import assert from "node:assert/strict";
import test from "node:test";
import { readDeploymentLedger } from "../deploy-safety/github-ledger.ts";
import { retryGitHubReads } from "./github-retry.ts";
import { requestJson } from "../deploy-safety/http.ts";

const url = "https://api.github.com/repos/owner/repo/deployments";

type Reply = number | Error | { status: number; headers: Record<string, string> };

function fakeGitHub(replies: Reply[]) {
  const calls: string[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    if (typeof reply === "object") return new Response("limited", reply);
    return reply === 200 ? Response.json([]) : new Response("upstream", { status: reply });
  };
  return { fetcher, calls };
}

function harness() {
  const waits: number[] = [];
  const lines: string[] = [];
  return {
    waits,
    lines,
    options: {
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
      },
      random: () => 0.5,
      now: () => 1_800_000_000_000,
      log: (line: string) => {
        lines.push(line);
      },
    },
  };
}

const reset = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

test("a read that fails twice with gateway errors succeeds on the third attempt", async () => {
  const github = fakeGitHub([502, 503, 200]);
  const h = harness();
  const reply = await requestJson(retryGitHubReads(github.fetcher, h.options), "GitHub", url, {});
  assert.deepEqual(reply.body, []);
  assert.equal(github.calls.length, 3);
  // Jittered exponential backoff: half to all of 1 s, then of 2 s.
  assert.deepEqual(h.waits, [750, 1500]);
  assert.deepEqual(h.lines, [
    "GitHub read GET api.github.com/repos/owner/repo/deployments attempt 1/3 failed (HTTP 502); retrying in 750 ms",
    "GitHub read GET api.github.com/repos/owner/repo/deployments attempt 2/3 failed (HTTP 503); retrying in 1500 ms",
  ]);
});

test("a read that always fails stops after three attempts and fails closed with the real status", async () => {
  const github = fakeGitHub([504]);
  const h = harness();
  await assert.rejects(
    requestJson(retryGitHubReads(github.fetcher, h.options), "GitHub", url, {}),
    /^SafetyGateError: GitHub request failed with HTTP 504$/,
  );
  assert.equal(github.calls.length, 3);
  assert.equal(
    h.lines.at(-1),
    "GitHub read GET api.github.com/repos/owner/repo/deployments failed after 3 attempts (HTTP 504)",
  );
});

test("connection resets retry, and a persistent reset surfaces the original transport failure", async () => {
  const recovered = fakeGitHub([reset(), 200]);
  const h = harness();
  assert.deepEqual(
    (await requestJson(retryGitHubReads(recovered.fetcher, h.options), "GitHub", url, {})).body,
    [],
  );
  assert.equal(recovered.calls.length, 2);
  assert.match(h.lines[0]!, /attempt 1\/3 failed \(ECONNRESET\)/);

  const down = fakeGitHub([reset()]);
  await assert.rejects(retryGitHubReads(down.fetcher, harness().options)(url), /fetch failed/);
  assert.equal(down.calls.length, 3);
});

test("other client errors, unknown failures, aborted reads and writes are never retried", async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const github = fakeGitHub([status, 200]);
    const response = await retryGitHubReads(github.fetcher, harness().options)(url);
    assert.equal(response.status, status);
    assert.equal(github.calls.length, 1, `HTTP ${status}`);
  }
  const unknown = fakeGitHub([new Error("unexpected redirect"), 200]);
  await assert.rejects(
    retryGitHubReads(unknown.fetcher, harness().options)(url),
    /unexpected redirect/,
  );
  assert.equal(unknown.calls.length, 1);

  const aborted = fakeGitHub([reset(), 200]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    retryGitHubReads(aborted.fetcher, harness().options)(url, { signal: controller.signal }),
  );
  assert.equal(aborted.calls.length, 1);

  const write = fakeGitHub([502, 200]);
  const response = await retryGitHubReads(write.fetcher, harness().options)(url, {
    method: "POST",
    body: "{}",
  });
  assert.equal(response.status, 502);
  assert.deepEqual(write.calls, ["POST"]);
});

test("the production ledger read survives one gateway error from GitHub", async () => {
  const github = fakeGitHub([502, 200]);
  const ledger = await readDeploymentLedger(
    { token: "fixture-token", repository: "owner/repo" },
    github.fetcher,
  );
  assert.equal(ledger.state, "uninitialized");
  assert.deepEqual(github.calls, ["GET", "GET"]);
});

test("a GitHub 500 retries like a gateway error and then succeeds", async () => {
  const github = fakeGitHub([500, 200]);
  const h = harness();
  const reply = await requestJson(retryGitHubReads(github.fetcher, h.options), "GitHub", url, {});
  assert.deepEqual(reply.body, []);
  assert.equal(github.calls.length, 2);
  assert.deepEqual(h.waits, [750]);
});

test("rate limits wait as GitHub asks, capped at a minute, and fall back to jitter", async () => {
  const limited = (headers: Record<string, string>, status = 429) => ({ status, headers });
  const resetIn5s = String(1_800_000_000 + 5);
  const cases: Array<[Reply, number]> = [
    [limited({ "retry-after": "2" }), 2_000],
    [limited({ "retry-after": "120" }), 60_000],
    [limited({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn5s }, 403), 5_000],
    [limited({}), 750],
  ];
  for (const [first, wait] of cases) {
    const github = fakeGitHub([first, 200]);
    const h = harness();
    const reply = await requestJson(retryGitHubReads(github.fetcher, h.options), "GitHub", url, {});
    assert.deepEqual(reply.body, []);
    assert.deepEqual(h.waits, [wait], JSON.stringify(first));
  }
});

test("a rate limit that never lifts stops after three attempts and fails closed", async () => {
  const github = fakeGitHub([{ status: 429, headers: { "retry-after": "1" } }]);
  const h = harness();
  await assert.rejects(
    requestJson(retryGitHubReads(github.fetcher, h.options), "GitHub", url, {}),
    /^SafetyGateError: GitHub request failed with HTTP 429$/,
  );
  assert.equal(github.calls.length, 3);
  assert.deepEqual(h.waits, [1_000, 1_000]);
});
