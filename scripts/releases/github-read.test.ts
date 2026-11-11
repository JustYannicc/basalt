import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApi } from "./github.ts";

for (const status of [503, 429]) {
  test(`recovers from transient HTTP ${status} and retains authentication`, async () => {
    let calls = 0;
    const waits: number[] = [];
    const api = new GitHubApi(
      "fixture-token",
      async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-token");
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal);
        return calls++ === 0
          ? new Response("temporary", { status, headers: { "retry-after": "3" } })
          : Response.json({ sha: "verified" });
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    assert.deepEqual(await api.get("repos/owner/repository/commits/pin"), { sha: "verified" });
    assert.equal(calls, 2);
    assert.ok(waits[0]! >= 3000);
  });
}

test("backs off for 5xx, stops at four attempts and allows a fresh call after failure", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new GitHubApi(
    "",
    async () => {
      calls++;
      return calls <= 4
        ? new Response("unavailable", { status: 503 })
        : Response.json({ ok: true });
    },
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  await assert.rejects(
    api.get("repos/owner/repository"),
    /GitHub API unavailable.*HTTP 503 after 4 attempt/,
  );
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.deepEqual(await api.get("repos/owner/repository"), { ok: true });
  assert.equal(calls, 5);
});

test("respects HTTP-date Retry-After and primary rate-limit reset", async () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  const waits: number[] = [];
  let calls = 0;
  const api = new GitHubApi(
    "",
    async () =>
      calls++ === 0
        ? new Response("limited", {
            status: 403,
            headers: {
              "retry-after": new Date(now + 70_000).toUTCString(),
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String((now + 80_000) / 1000),
            },
          })
        : Response.json({ ok: true }),
    {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.deepEqual(await api.get("repos/owner/repository"), { ok: true });
  assert.deepEqual(waits, [80_000]);
});

test("does not retry early when Retry-After exceeds the bounded wait budget", async () => {
  let calls = 0;
  const api = new GitHubApi(
    "",
    async () => {
      calls++;
      return new Response("limited", { status: 429, headers: { "retry-after": "3600" } });
    },
    {
      sleep: async () => {
        assert.fail("must not retry before GitHub permits it");
      },
    },
  );
  await assert.rejects(
    api.get("repos/owner/repository"),
    /GitHub API unavailable.*HTTP 429 after 1 attempt/,
  );
  assert.equal(calls, 1);
});

for (const status of [401, 403, 404]) {
  test(`does not retry permanent HTTP ${status} or mislabel it as drift`, async () => {
    let calls = 0;
    const api = new GitHubApi("", async () => {
      calls++;
      return new Response("rejected", { status });
    });
    await assert.rejects(
      api.get("repos/owner/repository"),
      (error: unknown) =>
        error instanceof Error &&
        error.message === `GitHub API ${status} for repos/owner/repository` &&
        "status" in error &&
        error.status === status,
    );
    assert.equal(calls, 1);
  });
}

test("retries transport failures without printing their potentially sensitive cause", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new GitHubApi(
    "",
    async () => {
      calls++;
      throw new Error("private transport details");
    },
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  await assert.rejects(
    api.get("repos/owner/repository"),
    /GitHub API unavailable.*transport failure after 4 attempt/,
  );
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test("does not retry mutations after an uncertain response", async () => {
  let calls = 0;
  const api = new GitHubApi("", async () => {
    calls++;
    return new Response("unavailable", { status: 503 });
  });
  await assert.rejects(api.request("POST", "repos/owner/repository/issues", {}), /GitHub API 503/);
  assert.equal(calls, 1);
});

test("retries a transport failure while reading a successful response body", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new GitHubApi(
    "",
    async () =>
      calls++ === 0
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("private body transport details"));
              },
            }),
          )
        : Response.json({ ok: true }),
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.deepEqual(await api.get("repos/owner/repository"), { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test("malformed JSON fails without retrying or exposing response bytes", async () => {
  let calls = 0;
  const api = new GitHubApi("", async () => {
    calls++;
    return new Response("private invalid response bytes");
  });
  await assert.rejects(api.get("repos/owner/repository"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /GitHub API returned invalid JSON/);
    assert.doesNotMatch(error.message, /private invalid response bytes/);
    return true;
  });
  assert.equal(calls, 1);
});

test("transport retries also obey the remaining rate-limit wait budget", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new GitHubApi(
    "",
    async () => {
      if (calls++ === 0)
        return new Response("limited", { status: 429, headers: { "retry-after": "120" } });
      throw new TypeError("transport failure");
    },
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  await assert.rejects(
    api.get("repos/owner/repository"),
    /GitHub API unavailable.*transport failure after 2 attempt/,
  );
  assert.deepEqual(waits, [120_000]);
  assert.equal(calls, 2);
});
