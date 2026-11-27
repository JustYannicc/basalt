import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { PoolControl, type ControlStorage } from "./attribution.ts";
import { signPoolToken } from "./token.ts";
import type { ResetAttempt, ResetCredits, ResetResult } from "../../apps/pool/action-contract.ts";

const signingKey = "ef".repeat(32);
const requestId = "12345678-abcd-4000-8000-000000000001";
const secondId = "12345678-abcd-4000-8000-000000000002";
type Json = Record<string, unknown>;
class Storage implements ControlStorage {
  values = new Map<string, unknown>();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async getAlarm() {
    return null;
  }
  async setAlarm() {}
}
const claudeGrants: readonly Json[] = [
  {
    id: "grant_1",
    resets_left: 2,
    starts_at: null,
    ends_at: "2030-01-04T00:00:00Z",
    paused: false,
    usable_now: true,
    use_requires_limit: true,
    clears: ["seven_day"],
  },
  {
    id: "blocked",
    resets_left: 2,
    paused: false,
    usable_now: false,
    use_requires_limit: true,
    clears: ["five_hour"],
  },
];
async function fixture(
  t: TestContext,
  provider = "codex",
  audience: readonly string[] = [],
  grants = claudeGrants,
  routeRefusals?: import("./account-actions.ts").RouteRefusals,
) {
  let now = Date.parse("2030-01-01T00:00:00Z");
  let disabled = false,
    member = true,
    collects = 0,
    consumes = 0,
    clears = 0;
  let observed = new Date(now - 60_000).toISOString();
  const calls: { path: string; method: string; body: Json }[] = [];
  let consume: (body: Json) => Promise<Json> = async () => ({
    status_code: 200,
    body: JSON.stringify({ code: "reset", result: "reset" }),
  });
  let cooldownFailure = false;
  let claudeCooldown: string | null = null;
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Json) : {};
      const url = new URL(req.url!, "http://home");
      const path = url.pathname.replace("/v8/management", "");
      calls.push({ path, method: req.method!, body });
      let value: unknown;
      if (path === "/channel-groups")
        value = { channel_groups: [{ id: 1, channel_name: "signalbox-pool-pool" }] };
      else if (path === "/channel-group-details")
        value = {
          channel_group_details: member ? [{ id: 1, channel_group_id: 1, auth_id: "account" }] : [],
        };
      else if (path === "/credentials")
        value = { files: [{ id: "account", provider, type: provider, disabled }] };
      else if (path === "/credentials/download")
        value = {
          type: "codex",
          account_id: "workspace-id",
          access_token: "SECRET-NOT-IN-RESULTS",
        };
      else if (path === "/credentials/status") {
        assert.equal(body.name, "account");
        disabled = body.disabled === true;
        value = { status: "ok", disabled };
      } else if (path === "/credentials/account/cooldown") {
        clears++;
        if (cooldownFailure) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: "SECRET-NOT-IN-RESULTS" }));
          return;
        }
        value = { credential_id: "account", cleared: true, scope: "all" };
      } else if (path === "/quota/collect") {
        assert.deepEqual(body.credential_ids, ["account"]);
        collects++;
        observed = new Date(now).toISOString();
        value = { accepted: 1 };
      } else if (path === "/quota/credentials/account")
        value = {
          credential: { credential_id: "account" },
          windows: [],
          collection: {
            status: "success",
            freshness: "fresh",
            observed_at: observed,
            last_attempt_at: collects ? observed : new Date(now - 31 * 60_000).toISOString(),
          },
        };
      else if (path === "/requests/api-call") {
        assert.equal(body.auth_index, "account");
        const target = new URL(String(body.url));
        const headers = body.header as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer $TOKEN$");
        if (target.hostname === "chatgpt.com")
          assert.equal(headers["Chatgpt-Account-Id"], "workspace-id");
        if (body.method === "POST") {
          consumes++;
          value = await consume(JSON.parse(String(body.data)) as Json);
        } else if (target.pathname.endsWith("/profile"))
          value = {
            status_code: 200,
            body: JSON.stringify({
              organization: { uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
            }),
          };
        else if (target.hostname === "chatgpt.com")
          value = {
            status_code: 200,
            body: JSON.stringify({
              available_count: 2,
              credits: [
                {
                  id: "credit",
                  reset_type: "codex_rate_limits",
                  status: "available",
                  expires_at: "2030-01-03T00:00:00Z",
                },
                {
                  id: "expired",
                  reset_type: "codex_rate_limits",
                  status: "available",
                  expires_at: "2029-01-01T00:00:00Z",
                },
                { id: "other-type", reset_type: "other", status: "available" },
              ],
            }),
          };
        else
          value = {
            status_code: 200,
            body: JSON.stringify({
              cedar_ember: {
                eligible: true,
                at_limit: true,
                cooldown_until: claudeCooldown,
                grants,
              },
            }),
          };
      } else {
        res.writeHead(404);
        value = {};
      }
      res.end(JSON.stringify(value));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const storage = new Storage();
  const deps = {
    signingKey,
    audience: async () => audience,
    home: (path: string, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${address.port}${path}`, init),
    now: () => new Date(now),
    routeRefusals,
  };
  let control = new PoolControl(storage, deps);
  const token = await signPoolToken(signingKey, {
    pool: "pool",
    owner: "owner",
    organization: "org",
  });
  const call = async (action: string, body?: Json, owner = true, id = "account") =>
    control.handle(
      new Request(`https://pool.example/pool/v1/accounts/${id}/${action}`, {
        method: action === "resets" || action === "resets/attempt" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-signalbox-caller": owner ? "owner" : "member",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const use = async (id = requestId, creditId = provider === "codex" ? "credit" : "grant_1") => {
    const response = await call("resets/use", { requestId: id, creditId });
    return { status: response.status, result: (await response.json()) as ResetResult };
  };
  return {
    call,
    use,
    calls,
    storage,
    counts: () => ({ collects, consumes, clears }),
    restart: () => {
      control = new PoolControl(storage, deps);
    },
    advance: (ms: number) => {
      now += ms;
    },
    remove: () => {
      member = false;
    },
    cooldownFailure: (fail: boolean) => {
      cooldownFailure = fail;
    },
    claudeCooldown: (value: string | null) => {
      claudeCooldown = value;
    },
    consume: (handler: typeof consume) => {
      consume = handler;
    },
  };
}

test("account actions authorize before contacting Home and cannot affect another pool's credential", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("pause", undefined, false)).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call("pause", undefined, true, "other")).status, 404);
  assert.equal(
    f.calls.some((call) => call.path === "/credentials/status"),
    false,
  );
  assert.equal((await f.call("pause")).status, 200);
  assert.equal((await f.call("resume")).status, 200);
  assert.deepEqual(
    f.calls.filter((call) => call.path === "/credentials/status").map((call) => call.body.disabled),
    [true, false],
  );
  assert.equal((await f.call("cooldown/clear")).status, 200);
});

test("a credential its plugin can't route can't be resumed while the route applies, even after the owner's own pause", async (t) => {
  // The pool's lift right (the marker) and whether a route applies are separate.
  const marked = new Set(["account"]);
  let routed = true;
  const asked: string[] = [];
  const f = await fixture(t, "codex", [], claudeGrants, {
    refusesUse: async (id, provider) => {
      asked.push(provider);
      return routed && id === "account";
    },
    refusedReferences: async () => marked,
    markRefused: async (id, value) => void (value ? marked.add(id) : marked.delete(id)),
  });
  const refuse = async () => {
    const resumed = await f.call("resume");
    assert.equal(resumed.status, 409);
    assert.equal(((await resumed.json()) as Json).error, "route_unsupported");
  };
  await refuse();
  assert.ok(!f.calls.some((call) => call.path === "/credentials/status"));
  // The owner's pause takes the lift right, never the refusal.
  assert.equal((await f.call("pause")).status, 200);
  assert.equal(marked.has("account"), false);
  await refuse();
  assert.deepEqual(asked, ["codex", "codex"]);
  // Once no route applies, resuming is the owner's again.
  routed = false;
  assert.equal((await f.call("resume")).status, 200);
});

test("a route that takes effect while a resume is on its way switches the credential off again", async (t) => {
  let checks = 0;
  const f = await fixture(t, "codex", [], claudeGrants, {
    // Free when the resume is checked, routed by the time Home has enabled it.
    refusesUse: async () => ++checks > 1,
    refusedReferences: async () => new Set(),
    markRefused: async () => {},
  });
  const resumed = await f.call("resume");
  assert.equal(resumed.status, 409);
  assert.equal(((await resumed.json()) as Json).error, "route_unsupported");
  assert.deepEqual(
    f.calls.filter((call) => call.path === "/credentials/status").map((call) => call.body.disabled),
    [false, true],
  );
});

test("manual refresh collects a fresh idle account once, retaining the shared persisted cap", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("refresh")).status, 200);
  f.restart();
  assert.equal((await f.call("refresh")).status, 200);
  assert.equal(f.counts().collects, 1);
  f.advance(30 * 60_000);
  assert.equal((await f.call("refresh")).status, 200);
  assert.equal(f.counts().collects, 2);
});

test("current audience members can refresh only accounts in their own pool", async (t) => {
  const denied = await fixture(t);
  assert.equal((await denied.call("refresh", undefined, false)).status, 403);
  assert.equal(denied.calls.length, 0);
  const f = await fixture(t, "codex", ["member"]);
  assert.equal((await f.call("refresh", undefined, false)).status, 200);
  assert.equal((await f.call("refresh", undefined, false, "other")).status, 404);
  assert.equal(f.counts().collects, 1);
});

test("Codex credit reads preserve usable metadata and exclude expired or unrelated credits", async (t) => {
  const f = await fixture(t);
  const response = await f.call("resets");
  assert.equal(response.status, 200);
  const value = (await response.json()) as ResetCredits;
  assert.equal(value.available, 1);
  assert.deepEqual(value.credits, [
    {
      id: "credit",
      type: "codex_rate_limits",
      remaining: 1,
      expiresAt: "2030-01-03T00:00:00.000Z",
      usableNow: null,
      requiresLimit: false,
      clears: null,
      kind: "unknown",
      scope: { kind: "account" },
    },
  ]);
  assert.equal(JSON.stringify(value).includes("SECRET-NOT-IN-RESULTS"), false);
});

test("same-key concurrent and restarted reset retries spend once and retry only failed follow-up work", async (t) => {
  const f = await fixture(t);
  f.cooldownFailure(true);
  const [a, b] = await Promise.all([f.use(), f.use()]);
  assert.equal(a.result.outcome, "reset");
  assert.equal(b.result.outcome, "reset");
  assert.equal(b.result.cooldownCleared, false);
  assert.equal(b.result.usageRefreshQueued, true);
  assert.equal(f.counts().consumes, 1);
  f.cooldownFailure(false);
  f.restart();
  const replay = await f.use(requestId.toUpperCase());
  assert.equal(replay.result.cooldownCleared, true);
  assert.deepEqual(f.counts(), { consumes: 1, clears: 3, collects: 1 });
  assert.equal(JSON.stringify([...f.storage.values]).includes("SECRET-NOT-IN-RESULTS"), false);
});

test("unknown reset outcomes keep the original id through restart and block another spend", async (t) => {
  const f = await fixture(t);
  const sent: Json[] = [];
  f.consume(async (body) => {
    sent.push(body);
    return { status_code: 502, body: "SECRET-NOT-IN-RESULTS" };
  });
  assert.equal((await f.use()).result.outcome, "unknown");
  f.restart();
  assert.equal((await f.use(secondId)).status, 409);
  f.consume(async (body) => {
    sent.push(body);
    return { status_code: 200, body: JSON.stringify({ code: "already_redeemed" }) };
  });
  assert.equal((await f.use()).result.outcome, "already_redeemed");
  assert.deepEqual(sent, [
    { redeem_request_id: requestId, credit_id: "credit" },
    { redeem_request_id: requestId, credit_id: "credit" },
  ]);
});

test("an expired unknown-attempt window does not send another provider request", async (t) => {
  const f = await fixture(t);
  f.consume(async () => ({ status_code: 500, body: "{}" }));
  await f.use();
  f.advance(10 * 60_000);
  f.restart();
  assert.equal((await f.use()).result.outcome, "unknown");
  assert.equal(f.counts().consumes, 1);
});

test("a retry refusal cannot settle an earlier ambiguous spend or permit a new request id", async (t) => {
  const f = await fixture(t);
  f.consume(async () => ({ status_code: 502, body: "{}" }));
  assert.equal((await f.use()).result.outcome, "unknown");
  f.restart();
  for (const status of [401, 429, 200]) {
    f.consume(async () => ({ status_code: status, body: JSON.stringify({ code: "no_credit" }) }));
    assert.equal((await f.use()).result.outcome, "unknown");
    assert.equal((await f.use(secondId)).status, 409);
  }
  assert.equal(f.counts().consumes, 4);
  assert.equal(f.counts().clears, 0);
});

test("Claude grants retain windows and use conditions, and claims pin the exact organization and grant", async (t) => {
  const f = await fixture(t, "claude");
  const response = await f.call("resets");
  const value = (await response.json()) as ResetCredits;
  assert.equal(value.available, 4);
  assert.deepEqual(value.credits.find((credit) => credit.id === "grant_1")?.clears, ["seven_day"]);
  assert.equal(value.credits.find((credit) => credit.id === "blocked")?.usableNow, false);
  assert.equal((await f.use(requestId, "blocked")).status, 409);
  assert.equal(f.counts().consumes, 0);
  const result = await f.use();
  assert.equal(result.result.outcome, "reset");
  const claim = f.calls.find(
    (call) => call.path === "/requests/api-call" && call.body.method === "POST",
  )!;
  assert.equal(
    claim.body.url,
    "https://api.anthropic.com/api/organizations/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/reset_rate_limits",
  );
  assert.deepEqual(JSON.parse(String(claim.body.data)), {
    program: "cedar_ember",
    grant_id: "grant_1",
    request_id: requestId,
  });
});

// Grants as Anthropic reports them: a Fable reset gives back only Fable's weekly use, and its
// `clears` names the weekly overage window, so the window alone reads like a weekly reset.
const kindGrants: readonly Json[] = [
  {
    id: "weekly",
    type: "weekly",
    resets_left: 1,
    ends_at: "2030-01-04T00:00:00Z",
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: ["seven_day"],
  },
  {
    id: "fable",
    type: "weekly",
    resets_left: 3,
    gives_back_weekly: true,
    ends_at: "2030-01-03T00:00:00Z",
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: ["seven_day_overage_included"],
  },
  {
    id: "session",
    resets_left: 2,
    ends_at: "2030-01-02T00:00:00Z",
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: ["five_hour"],
  },
  {
    id: "full",
    resets_left: 1,
    ends_at: "2030-01-05T00:00:00Z",
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: ["five_hour", "seven_day"],
  },
  {
    id: "spark",
    resets_left: 1,
    ends_at: "2030-01-06T00:00:00Z",
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: ["seven_day_spark"],
  },
  // The rest of the Home's table: an unknown type, a typed grant with no windows, a model with
  // the account week, a grant naming nothing, and a model id longer than a hosted read takes.
  {
    id: "monthly",
    type: "monthly",
    resets_left: 1,
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: ["seven_day"],
  },
  {
    id: "typed",
    type: "session",
    resets_left: 1,
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: [],
  },
  {
    id: "mixed",
    resets_left: 1,
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: ["seven_day", "seven_day_fable"],
  },
  {
    id: "bare",
    resets_left: 1,
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: [],
  },
  {
    id: "long",
    resets_left: 1,
    paused: false,
    usable_now: true,
    use_requires_limit: false,
    clears: [`seven_day_${"m".repeat(65)}`],
  },
];

test("the spend catalog names each grant's kind and scope by the Home's rule, so a model reset never reads as weekly", async (t) => {
  const f = await fixture(t, "claude", [], kindGrants);
  const value = (await (await f.call("resets")).json()) as ResetCredits;
  const kinds = Object.fromEntries(
    value.credits.map((credit) => [credit.id, [credit.kind, credit.scope]]),
  );
  assert.deepEqual(kinds, {
    weekly: ["weekly", { kind: "account" }],
    fable: ["model", { kind: "model", id: "fable" }],
    session: ["session", { kind: "account" }],
    full: ["full", { kind: "account" }],
    spark: ["model", { kind: "model", id: "spark" }],
    monthly: ["unknown", { kind: "unknown" }],
    typed: ["session", { kind: "account" }],
    mixed: ["unknown", { kind: "unknown" }],
    bare: ["unknown", { kind: "unknown" }],
    long: ["unknown", { kind: "unknown" }],
  });
  const codex = await fixture(t);
  const credits = (await (await codex.call("resets")).json()) as ResetCredits;
  // Codex decides which of the account's limits a reset clears; it is never a model's reset.
  assert.deepEqual(
    credits.credits.map((credit) => [credit.kind, credit.scope]),
    [["unknown", { kind: "account" }]],
  );
});

test("a spend confirmed as a weekly reset never consumes a model reset's grant", async (t) => {
  const f = await fixture(t, "claude", [], kindGrants);
  const weekly = { kind: "weekly", scope: { kind: "account" } };
  const refused = await f.call("resets/use", { requestId, creditId: "fable", ...weekly });
  assert.equal(refused.status, 409);
  assert.equal(f.counts().consumes, 0);
  // The refusal recorded nothing, so the same request can still spend what was confirmed.
  const spent = await f.call("resets/use", { requestId, creditId: "weekly", ...weekly });
  assert.equal(((await spent.json()) as ResetResult).outcome, "reset");
  const claim = f.calls.find(
    (call) => call.path === "/requests/api-call" && call.body.method === "POST",
  )!;
  assert.equal(JSON.parse(String(claim.body.data)).grant_id, "weekly");
  const fable = await f.call("resets/use", {
    requestId: secondId,
    creditId: "fable",
    kind: "model",
    scope: { kind: "model", id: "fable" },
  });
  assert.equal(((await fable.json()) as ResetResult).outcome, "reset");
  assert.equal(f.counts().consumes, 2);
});

test("a partial or unknown confirmation is refused, never read as any kind", async (t) => {
  const f = await fixture(t, "claude", [], kindGrants);
  for (const confirmation of [
    { kind: "weekly" },
    { scope: { kind: "account" } },
    { kind: "monthly", scope: { kind: "account" } },
    { kind: "weekly", scope: { kind: "team" } },
  ]) {
    const response = await f.call("resets/use", { requestId, creditId: "weekly", ...confirmation });
    assert.equal(response.status, 400, JSON.stringify(confirmation));
  }
  assert.equal(f.counts().consumes, 0);
});

test("two spends on one account run one after the other: the second reads grants only after the first claim answered", async (t) => {
  const f = await fixture(t, "claude", [], kindGrants);
  const grantReads = () =>
    f.calls.filter(
      (call) =>
        call.path === "/requests/api-call" &&
        call.body.method === "GET" &&
        String(call.body.url).includes("cedar_ember"),
    ).length;
  const readsAtClaim: number[] = [];
  f.consume(async () => {
    readsAtClaim.push(grantReads());
    return { status_code: 200, body: JSON.stringify({ result: "reset" }) };
  });
  const [first, second] = await Promise.all([
    f.call("resets/use", {
      requestId,
      creditId: "weekly",
      kind: "weekly",
      scope: { kind: "account" },
    }),
    f.call("resets/use", {
      requestId: secondId,
      creditId: "fable",
      kind: "model",
      scope: { kind: "model", id: "fable" },
    }),
  ]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.deepEqual(readsAtClaim, [1, 2]);
});

test("removing membership blocks reset replays and malformed request IDs never reach a provider", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.use("bad-id")).status, 400);
  assert.equal(f.counts().consumes, 0);
  await f.use();
  f.remove();
  assert.equal((await f.use()).status, 404);
  assert.equal(f.counts().consumes, 1);
});

test("Claude cooldown prevents a new claim even when the grant's usable_now flag is true", async (t) => {
  const f = await fixture(t, "claude");
  f.claudeCooldown("2030-01-01T00:10:00Z");
  const response = await f.call("resets");
  const value = (await response.json()) as ResetCredits;
  assert.equal(value.credits.find((credit) => credit.id === "grant_1")?.usableNow, false);
  assert.equal((await f.use()).status, 409);
  assert.equal(f.counts().consumes, 0);
  f.advance(10 * 60_000);
  assert.equal((await f.use()).result.outcome, "reset");
});

test("an owner can recover an unknown reset after restart without another provider call", async (t) => {
  const f = await fixture(t);
  assert.equal(await (await f.call("resets/attempt")).json(), null);
  f.consume(async () => ({ status_code: 502, body: "{}" }));
  await f.use();
  f.restart();
  const before = f.counts();
  const read = await f.call("resets/attempt");
  assert.equal(read.status, 200);
  const attempt = (await read.json()) as ResetAttempt;
  assert.deepEqual(attempt, {
    provider: "codex",
    creditId: "credit",
    requestId,
    startedAt: "2030-01-01T00:00:00.000Z",
    retryUntil: "2030-01-01T00:10:00.000Z",
    canRetryProvider: true,
    outcome: "unknown",
    cooldownCleared: false,
    usageRefreshQueued: false,
  });
  assert.deepEqual(f.counts(), before);
  assert.equal((await f.use(secondId)).status, 409);
  f.advance(10 * 60_000);
  f.restart();
  assert.deepEqual(await (await f.call("resets/attempt")).json(), {
    ...attempt,
    canRetryProvider: false,
  });
  assert.deepEqual(f.counts(), before);
  assert.equal((await f.use(secondId)).status, 409);
});

test("reset attempt reads recover confirmed follow-ups and retain account authorization", async (t) => {
  const f = await fixture(t);
  f.cooldownFailure(true);
  await f.use();
  f.restart();
  const before = f.counts();
  const attempt = (await (await f.call("resets/attempt")).json()) as ResetAttempt;
  assert.equal(attempt.requestId, requestId);
  assert.equal(attempt.outcome, "reset");
  assert.equal(attempt.canRetryProvider, false);
  assert.equal(attempt.cooldownCleared, false);
  assert.equal(attempt.usageRefreshQueued, true);
  assert.deepEqual(f.counts(), before);
  assert.equal((await f.call("resets/attempt", undefined, false)).status, 403);
  assert.equal((await f.call("resets/attempt", undefined, true, "other")).status, 404);
  f.remove();
  assert.equal((await f.call("resets/attempt")).status, 404);
  assert.deepEqual(f.counts(), before);
});
