import assert from "node:assert/strict";
import { test } from "node:test";
import type { Account, PoolView } from "../../apps/pool/contract.ts";
import { subscriptionFailure } from "../../apps/pool/account-health.ts";
import { attributionStorageKey } from "./attribution.ts";
import { handleControl, HomeClient } from "./control.ts";
import providers from "./providers.json" with { type: "json" };
import { fixture, error, provider, type Row } from "./test/control.ts";

test("an account check forces a scoped Home collection and returns its completed reading", async () => {
  const f = await fixture();
  f.home.addFile("checked");
  f.home.addGroup("pool-a", 10, ["checked"]);
  let collected = false;
  f.home.override = (path, init) => {
    if (path.endsWith("/quota/collect")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { credential_ids: ["checked"] });
      collected = true;
      return Response.json({ accepted: 1, running: true }, { status: 202 });
    }
    if (path.endsWith("/quota/credentials/checked"))
      return Response.json({
        credential: { credential_id: "checked" },
        windows: [],
        reset_credits: null,
        collection: {
          status: collected ? "success" : "idle",
          freshness: collected ? "fresh" : "never",
          observed_at: collected ? f.deps.now().toISOString() : null,
          last_attempt_at: collected ? f.deps.now().toISOString() : null,
        },
      });
    return undefined;
  };
  await f.call("/pool");
  const response = await f.call("/accounts/checked/collect", { method: "POST" });
  assert.equal(response.status, 200, await response.clone().text());
  const value = (await response.json()) as Row;
  assert.equal(value.id, "checked");
  assert.equal(value.freshness, "fresh");
  assert.equal(collected, true);
  const after = (await (await f.call("/pool")).json()) as PoolView;
  assert.equal(after.reading?.source, "live");
  assert.equal(after.accounts[0]!.observedAt, f.deps.now().toISOString());
  await error(await f.call("/accounts/other/collect", { method: "POST" }), "not_found", 404);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 1);
});

test("members may check only their current pool's accounts", async () => {
  const denied = await fixture();
  await error(
    await denied.call("/accounts/a/collect", { method: "POST", owner: false }),
    "not_owner",
    403,
  );
  assert.equal(denied.home.calls.length, 0);
  const f = await fixture(["fake-member"]);
  f.home.addFile("a");
  f.home.addGroup("pool-a", 10, ["a"]);
  f.home.override = (path) =>
    path.endsWith("/quota/credentials/a")
      ? Response.json({
          credential: { credential_id: "a" },
          windows: [],
          collection: {
            status: "success",
            freshness: "fresh",
            observed_at: f.deps.now().toISOString(),
          },
        })
      : undefined;
  assert.equal((await f.call("/accounts/a/collect", { method: "POST", owner: false })).status, 200);
  await error(
    await f.call("/accounts/a/collect", { method: "POST", owner: false, pool: "pool-b" }),
    "not_found",
    404,
  );
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 0);
});

test("a failed collection exposes only its known error code, with no diagnostic data", async () => {
  const f = await fixture();
  f.home.addFile("a");
  f.home.addGroup("pool-a", 10, ["a"]);
  f.home.override = (path) =>
    path.endsWith("/quota/credentials/a")
      ? Response.json({
          credential: { credential_id: "a" },
          windows: [],
          collection: {
            status: "failed",
            freshness: "never",
            last_attempt_at: f.deps.now().toISOString(),
            error: {
              code: "UPSTREAM_AUTH_REJECTED",
              message: "private-provider-response",
              request_id: "private-id",
            },
          },
        })
      : undefined;
  const response = await f.call("/accounts/a/collect", { method: "POST" });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes("private"));
  assert.deepEqual((JSON.parse(body) as Row).collection, {
    status: "failed",
    errorCode: "UPSTREAM_AUTH_REJECTED",
    lastAttemptAt: f.deps.now().toISOString(),
  });
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 0);
});

for (const [name, blocked, upstream, expected] of [
  ["refused refresh", true, 401, "unauthorized"],
  ["transient refresh", true, 503, "unavailable"],
  ["quota cooldown", false, 429, null],
] as const) {
  test(`a fresh quota cannot hide a ${name}`, async () => {
    const f = await fixture();
    f.home.addFile("a");
    f.home.addGroup("pool-a", 10, ["a"]);
    f.home.files.set("a", {
      ...f.home.files.get("a"),
      unavailable: true,
      status: blocked ? "error" : "active",
    });
    f.home.override = (path) => {
      if (path.endsWith("/quota/credentials/a"))
        return Response.json({
          credential: { credential_id: "a" },
          windows: [],
          collection: {
            status: "success",
            freshness: "fresh",
            observed_at: f.deps.now().toISOString(),
          },
        });
      if (path.endsWith("/credentials/a/model-states"))
        return Response.json({
          credential: {
            credential_id: "a",
            refresh_blocked: blocked,
            last_error: { upstream: { status: upstream, body: "private-provider-response" } },
          },
        });
      return undefined;
    };
    const response = await f.call("/accounts/a/collect", { method: "POST" });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes("private"));
    assert.equal(
      subscriptionFailure(JSON.parse(body) as Account, f.deps.now().getTime()),
      expected,
    );
  });
}

for (const step of ["membership", "credentials", "quota", "runtime"] as const) {
  test(`a canceled health check does not wait for hung Home ${step}`, async () => {
    const f = await fixture();
    f.home.addFile("a");
    f.home.addGroup("pool-a", 10, ["a"]);
    if (step === "runtime") f.home.files.set("a", { ...f.home.files.get("a"), status: "error" });
    const entered = deferred<void>(),
      release = deferred<void>();
    const controller = new AbortController();
    f.home.override = async (path, init) => {
      const held =
        step === "membership"
          ? path.endsWith("/channel-groups")
          : step === "credentials"
            ? path.endsWith("/credentials")
            : step === "quota"
              ? path.endsWith("/quota/credentials/a")
              : path.endsWith("/model-states");
      if (held) {
        assert.ok(init?.signal, "every Home read gets the check's deadline");
        entered.resolve();
        await release.promise;
      }
      if (path.endsWith("/quota/credentials/a"))
        return Response.json({
          credential: { credential_id: "a" },
          windows: [],
          collection: {
            status: "success",
            freshness: "fresh",
            observed_at: f.deps.now().toISOString(),
          },
        });
      return undefined;
    };
    const checking = f.call("/accounts/a/collect", { method: "POST", signal: controller.signal });
    await entered.promise;
    controller.abort();
    try {
      await withoutWaitingForGate(checking);
      await error(await checking, "backend_unavailable", 503);
    } finally {
      release.resolve();
      await checking;
    }
  });
}

test("invalid and absent pool tokens never contact Home", async () => {
  const f = await fixture();
  for (const token of ["fake-token", "sbp1.invalid.invalid", ""])
    await error(await f.call("/pool", { token }), "unauthorized", 401);
  const response = await handleControl(new Request("https://pool.example/pool/v1/pool"), {
    ...f.deps,
    attribution: null,
  });
  await error(response, "unauthorized", 401);
  assert.equal(f.home.calls.length, 0);
});

test("only GET pool is available to a non-owner; empty reads create no Home resources", async () => {
  const f = await fixture();
  const view = (await (await f.call("/pool", { owner: false })).json()) as PoolView;
  assert.deepEqual(view, {
    isOwner: false,
    providers,
    accounts: [],
    reading: {
      source: "live",
      revalidationFailed: false,
      readAt: {
        membership: f.deps.now().toISOString(),
        credentials: f.deps.now().toISOString(),
      },
    },
  });
  for (const [path, method] of [
    ["/sign-ins", "POST"],
    ["/sign-ins", "DELETE"],
    ["/sign-ins/status", "GET"],
    ["/sign-ins/callback", "POST"],
    ["/login-files", "POST"],
    ["/accounts/fake", "DELETE"],
  ]) {
    await error(await f.call(path!, { method, owner: false }), "not_owner", 403);
  }
  assert.deepEqual(
    f.home.calls.map((call) => call.path),
    ["/v8/management/channel-groups", "/v8/management/credentials"],
  );
});

test("unknown routes and lookalike boundaries return not_found", async () => {
  const f = await fixture();
  for (const path of ["", "/", "/other", "/pool/", "/accounts/a/extra"])
    await error(await f.call(path, { method: "DELETE" }), "not_found", 404);
  const response = await handleControl(
    new Request("https://pool.example/pool/v10/pool", {
      headers: (await f.request("/pool")).headers,
    }),
    { ...f.deps, attribution: null },
  );
  await error(response, "not_found", 404);
});

test("duplicate channel groups use the lowest id and all duplicate members are visible", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 10, ["first"]);
  f.home.addFile("first");
  f.home.addGroup("pool-a", 20, ["second"]);
  f.home.addFile("second");
  const view = (await (await f.call("/pool")).json()) as PoolView;
  assert.deepEqual(
    view.accounts.map((account) => account.id),
    ["first", "second"],
  );
});

test("pool view filters global credentials and quotas, sorts ids and normalizes usage", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["z", "a", "u", "e"]);
  f.home.addGroup("pool-b", 2, ["foreign"]);
  f.home.addFile("foreign");
  f.home.addFile("z", "synthetic", {
    disabled: true,
    unavailable: true,
    status: "error",
    email: "fake@example.invalid",
  });
  f.home.addFile("a", provider, { unavailable: true });
  f.home.addFile("u");
  f.home.addFile("e", provider, { status: "error", status_message: "Needs sign-in" });
  f.home.quota = [
    {
      credential_id: "z",
      plan: { name: "Example plan" },
      observed_at: "2026-01-01T00:00:00Z",
      primary_windows: [
        {
          id: "high",
          label: "High",
          remaining_ratio: 2,
          reset_at: "2026-01-02T00:00:00Z",
          window_seconds: 3600,
        },
        { id: "low", label: "Low", used_ratio: 2 },
        { id: "unknown", label: "Unknown" },
        {
          id: "unlimited",
          label: "Unlimited",
          is_unlimited: true,
          remaining_ratio: 0,
          reset_at: "ignored",
        },
      ],
    },
    { credential_id: "foreign", plan: { name: "Private" } },
  ];
  const view = (await (await f.call("/pool")).json()) as PoolView;
  assert.deepEqual(
    view.accounts.map((account) => [account.id, account.state]),
    [
      ["a", "unavailable"],
      ["e", "error"],
      ["u", "active"],
      ["z", "disabled"],
    ],
  );
  assert.equal(view.accounts[3]!.plan, "Example plan");
  assert.equal(view.accounts[3]!.label, "fake@example.invalid");
  assert.deepEqual(
    view.accounts[3]!.windows.map((window) => window.remainingRatio),
    [1, 0, null, 1],
  );
  assert.equal(view.accounts[3]!.windows[3]!.resetAt, null);
  assert.equal(view.accounts[0]!.observedAt, null);
  assert.ok(!f.home.calls.find((call) => call.path.includes("/quota/"))!.path.includes("foreign"));
});

test("delete refuses foreign ids and deletes every duplicate membership for owned ids", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["ours"]);
  f.home.addGroup("pool-a", 2, ["ours"]);
  f.home.addGroup("pool-b", 3, ["foreign"]);
  f.home.addFile("ours");
  f.home.addFile("foreign");
  await error(await f.call("/accounts/foreign", { method: "DELETE" }), "not_found", 404);
  assert.equal((await f.call("/accounts/ours", { method: "DELETE" })).status, 200);
  assert.equal(f.home.files.has("ours"), false);
  assert.equal(f.home.files.has("foreign"), true);
  assert.deepEqual(
    f.home.members.map((member) => member.auth_id),
    ["foreign"],
  );
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function withoutWaitingForGate(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("request was blocked by unrelated work")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("GET pool bypasses an in-flight attribution request and never loads its state", async () => {
  const f = await fixture();
  await f.call("/pool");
  assert.equal(f.storage.readKeys.includes(attributionStorageKey), false);
  assert.ok(f.storage.values.has("pool-view-snapshot-v1:pool-a"));
  const started = (await (await f.acquire("start")).json()) as { session: string };
  const entered = deferred();
  const release = deferred();
  f.home.override = async (path) => {
    if (path.includes("/oauth/status")) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const poll = f.acquire("status", { session: started.session });
  await entered.promise;
  const before = { reads: f.storage.gets, writes: f.storage.puts, alarms: f.storage.alarmReads };
  let view: Response | undefined;
  const read = f.call("/pool", { pool: "pool-b" }).then((response) => {
    view = response;
  });
  try {
    await withoutWaitingForGate(read);
    assert.equal(view?.status, 200, "the view should finish while status is blocked");
    assert.equal(f.storage.readKeys.slice(before.reads).includes(attributionStorageKey), false);
    assert.ok(f.storage.values.has("pool-view-snapshot-v1:pool-b"));
    assert.equal(f.storage.puts, before.writes + 1);
    assert.equal(f.storage.alarmReads, before.alarms);
  } finally {
    release.resolve();
    await Promise.all([poll, read]);
  }
});

test("empty pool view ignores a failed global credential read", async () => {
  const f = await fixture();
  f.home.override = (path) =>
    path.endsWith("/credentials") ? Response.json({}, { status: 503 }) : undefined;
  const response = await f.call("/pool");
  assert.equal(response.status, 200);
  const view = (await response.json()) as PoolView;
  assert.deepEqual(view.accounts, []);
  assert.equal(view.reading?.source, "live");
  assert.equal(view.reading?.revalidationFailed, false);
  assert.equal(view.reading?.readAt.credentials, undefined);
  assert.equal(view.reading?.readAt.quota, undefined);
});

test("empty pool view cancels a hung credential read without waiting for it", async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let aborted = false;
  f.home.override = async (path, init) => {
    if (path.endsWith("/credentials")) {
      init?.signal?.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const reading = f.call("/pool");
  await entered.promise;
  try {
    await withoutWaitingForGate(reading);
    const response = await reading;
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as PoolView).accounts, []);
    assert.equal(aborted, true);
  } finally {
    release.resolve();
    await reading;
  }
});

test("populated pool view still refuses a failed required credential read", async () => {
  const f = await fixture();
  f.home.addFile("a");
  f.home.addGroup("pool-a", 10, ["a"]);
  f.home.override = (path) =>
    path.endsWith("/credentials") ? Response.json({}, { status: 503 }) : undefined;
  await error(await f.call("/pool"), "backend_unavailable", 503);
});

test("pool view starts credentials before membership finishes", async () => {
  const f = await fixture();
  f.home.addFile("a");
  f.home.addGroup("pool-a", 10, ["a"]);
  const entered = deferred<void>(),
    release = deferred<void>(),
    credentials = deferred<void>();
  f.home.override = async (path) => {
    if (path.endsWith("/channel-groups")) {
      entered.resolve();
      await release.promise;
    }
    if (path.endsWith("/credentials")) credentials.resolve();
    return undefined;
  };
  const reading = f.call("/pool");
  await entered.promise;
  try {
    await withoutWaitingForGate(credentials.promise);
    assert.ok(f.home.calls.some((call) => call.path.endsWith("/credentials")));
  } finally {
    release.resolve();
    await reading;
  }
});

test("pool view reads credentials and quota concurrently and reuses cached channel groups", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["account"]);
  f.home.addFile("account");
  const entered = deferred();
  const release = deferred();
  f.home.override = async (path) => {
    if (path.endsWith("/credentials")) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const reading = f.call("/pool");
  await entered.promise;
  await nextTurn();
  try {
    assert.ok(f.home.calls.some((call) => call.path.includes("/quota/credentials/")));
  } finally {
    release.resolve();
    await reading;
  }
  f.home.override = undefined;
  await f.call("/pool");
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/channel-groups")).length, 1);
  assert.equal(
    f.home.calls.filter((call) => call.path.includes("/quota/credentials/")).length,
    1,
    "a second view reuses the cached detail read",
  );
  // A deleted cached group is re-discovered after Home's 404.
  f.home.groups = [{ id: 4, channel_name: "signalbox-pool-pool-a" }];
  f.home.members = [{ id: 4, channel_group_id: 4, auth_id: "account" }];
  f.home.override = (path) =>
    path.endsWith("/channel-group-details?channel_group_id=1")
      ? Response.json({ error: "not_found" }, { status: 404 })
      : undefined;
  const view = (await (await f.call("/pool")).json()) as PoolView;
  assert.deepEqual(
    view.accounts.map((account) => account.id),
    ["account"],
  );
});

test("a missing quota detail leaves that account visible and a refresh drops its cached detail", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["missing", "refreshed"]);
  f.home.addFile("missing");
  f.home.addFile("refreshed");
  f.home.override = (path) =>
    path.endsWith("/quota/credentials/missing") ? Response.json({}, { status: 404 }) : undefined;
  const view = (await (await f.call("/pool")).json()) as PoolView;
  assert.deepEqual(
    view.accounts.map((account) => account.id),
    ["missing", "refreshed"],
  );
  assert.equal(view.accounts.find((account) => account.id === "missing")!.freshness, "never");
  const client = new HomeClient(f.home.fetch);
  const before = f.home.calls.filter((call) =>
    call.path.endsWith("/quota/credentials/refreshed"),
  ).length;
  await client.quota(["refreshed"], true);
  await client.quota(["refreshed"], true);
  assert.equal(
    f.home.calls.filter((call) => call.path.endsWith("/quota/credentials/refreshed")).length,
    before + 1,
  );
  await client.refreshQuota(["refreshed"]);
  await client.quota(["refreshed"], true);
  assert.equal(
    f.home.calls.filter((call) => call.path.endsWith("/quota/credentials/refreshed")).length,
    before + 2,
  );
});

test("a failed credential delete preserves membership and retry authority", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["partial-remove"]);
  f.home.addFile("partial-remove");
  f.storage.values.set(attributionStorageKey, {
    version: 2,
    locks: {},
    sessions: {},
    assigned: ["partial-remove"],
  });
  f.home.override = (path, init) =>
    path.includes("/credentials?id=") && init?.method === "DELETE"
      ? Response.json({ error: "fake delete failure" }, { status: 503 })
      : undefined;
  await error(
    await f.call("/accounts/partial-remove", { method: "DELETE" }),
    "backend_unavailable",
    503,
  );
  assert.equal(f.home.members.length, 1);
  assert.equal(f.home.files.has("partial-remove"), true);
  assert.deepEqual(
    (f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned,
    ["partial-remove"],
  );
  f.home.override = undefined;
  assert.equal((await f.call("/accounts/partial-remove", { method: "DELETE" })).status, 200);
  assert.equal(f.home.members.length, 0);
  assert.equal(f.home.files.has("partial-remove"), false);
  assert.deepEqual(
    (f.storage.values.get(attributionStorageKey) as { assigned: string[] }).assigned,
    [],
  );
});

for (const count of [75, 205]) {
  test(`pool view reads all ${count} details; sampler lists stay within Home's 200-item limit`, async () => {
    const f = await fixture();
    const ids = Array.from({ length: count }, (_, i) => `account-${String(i).padStart(3, "0")}`);
    f.home.addGroup("pool-a", 1, ids);
    for (const id of ids) {
      f.home.addFile(id);
      f.home.quota.push({
        credential_id: id,
        plan: { name: `plan-${id}` },
        primary_windows: [
          { id: "usage", scope: "account", window_seconds: 604800, remaining_ratio: 0.5 },
        ],
      });
    }
    const view = (await (await f.call("/pool")).json()) as PoolView;
    assert.equal(view.accounts.length, count);
    for (const account of view.accounts) {
      assert.equal(account.plan, `plan-${account.id}`);
      assert.equal(account.windows.length, 1);
    }
    assert.equal(
      f.home.calls.filter((call) => call.path.includes("/quota/credentials/")).length,
      count,
    );
    assert.equal((await new HomeClient(f.home.fetch).quota(ids)).length, count);
    const calls = f.home.calls.filter((call) => call.path.includes("/quota/credentials?"));
    assert.equal(calls.length, Math.ceil(count / 200));
    for (const call of calls) {
      const query = new URL(`https://home.example${call.path}`).searchParams;
      assert.equal(Number(query.get("limit")), query.get("ids")!.split(",").length);
      assert.ok(Number(query.get("limit")) <= 200);
    }
  });
}

test("a credential already deleted is harmless on retry after membership cleanup fails", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["delete-retry"]);
  f.home.addFile("delete-retry");
  f.home.override = (path, init) =>
    path.includes("/channel-group-details/") && init?.method === "DELETE"
      ? Response.json({ error: "fake membership outage" }, { status: 503 })
      : undefined;
  await error(
    await f.call("/accounts/delete-retry", { method: "DELETE" }),
    "backend_unavailable",
    503,
  );
  assert.equal(f.home.files.has("delete-retry"), false);
  assert.equal(f.home.members.length, 1);
  const mutations = f.home.calls.filter((call) => call.method === "DELETE");
  assert.match(mutations[0]!.path, /credentials\?id=/);
  f.home.override = undefined;
  f.restart();
  assert.equal((await f.call("/accounts/delete-retry", { method: "DELETE" })).status, 200);
  assert.equal(f.home.members.length, 0);
});

function usageRow(
  id: string,
  account: string,
  session = "b2dff7a4-658d-811d-ab12-7d8bbe4e6157",
  key = 17,
  status = "success",
): Row {
  return {
    id,
    usage_id: Number(id),
    credential: {
      credential_id: account,
      auth_index: "different-index",
      api_key_preview: "obviously-fake-provider-key",
    },
    session_id: session,
    parent_session_id: "header:fake-parent",
    root_session_id: "header:fake-root",
    status,
    timestamp: "2026-01-01T00:00:00.123456Z",
    request_id: `fake-request-${id}`,
    client: {
      api_key_id: key,
      api_key_masked: "obviously-fake-client-secret",
      username: "fake-person",
    },
    tokens: { total_tokens: 123 },
    billing: { amount: 1 },
    runtime: { home_ip: "192.0.2.1" },
  };
}

test("owner usage returns only exact-session pool records and only four public fields", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["own-account"]);
  f.home.addGroup("pool-b", 2, ["other-account"]);
  f.home.addFile("own-account");
  f.home.addFile("other-account");
  f.home.usage = [
    usageRow("101", "own-account"),
    usageRow("102", "other-account"),
    usageRow("103", "own-account"),
  ];
  const response = await f.call("/usage?session=fake-run");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    records: [
      { id: "101", account: "own-account", status: "success", at: "2026-01-01T00:00:00.123456Z" },
      { id: "103", account: "own-account", status: "success", at: "2026-01-01T00:00:00.123456Z" },
    ],
  });
  assert.equal(f.storage.gets, 0, "usage does not load control storage");
  const view = (await (await f.call("/pool")).json()) as PoolView;
  assert.equal(view.accounts[0]!.id, "own-account");
  const call = f.home.calls.find((call) => call.path.includes("/usage/records?"))!;
  const query = new URL(`https://home.example${call.path}`).searchParams;
  assert.equal(query.get("session_id"), "b2dff7a4-658d-811d-ab12-7d8bbe4e6157");
  assert.equal(query.get("limit"), "200");
  assert.equal(query.has("parent_session_id"), false);
  assert.equal(query.has("root_session_id"), false);
  assert.equal(f.storage.readKeys.includes(attributionStorageKey), false);
  assert.ok(f.storage.values.has("pool-view-snapshot-v1:pool-a"));
  assert.equal(f.storage.puts, 1);
});

test("usage rejects non-owners and invalid tokens before Home or attribution storage", async () => {
  const f = await fixture();
  await error(await f.call("/usage?key=17", { owner: false }), "not_owner", 403);
  await error(
    await f.call("/usage?session=fake-run", { token: "obviously-invalid" }),
    "unauthorized",
    401,
  );
  assert.equal(f.home.calls.length, 0);
  assert.equal(f.storage.gets, 0);
});

test("usage for a missing session or an empty pool returns an empty list", async () => {
  const f = await fixture();
  assert.deepEqual(await (await f.call("/usage?session=fake-run")).json(), { records: [] });
  assert.equal(
    f.home.calls.some((call) => call.path.includes("/usage/records?")),
    false,
  );
  f.home.addGroup("pool-a", 1, ["own-account"]);
  f.restart();
  f.home.usage = [usageRow("101", "own-account")];
  assert.deepEqual(await (await f.call("/usage?session=no-such-run")).json(), { records: [] });
});

test("usage accepts only the node's canonical session, excluding raw, child and parent sessions", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["own-account"]);
  f.home.ignoreUsageFilters = true;
  f.home.usage = [
    usageRow("99", "own-account", "header:fake-run"),
    usageRow("100", "own-account", "fake-run"),
    usageRow("101", "own-account", "header:fake-run:child"),
    usageRow("102", "own-account", "header:fake-parent"),
    usageRow("103", "own-account", "header:fake-root"),
    usageRow("104", "own-account", "00000000-0000-8000-8000-000000000001"),
    usageRow("105", "own-account"),
  ];
  const response = await f.call(
    "/usage?session=fake-run&limit=1&parent_session_id=ignored&root_session_id=ignored",
  );
  assert.equal(response.status, 200);
  const value = (await response.json()) as { records: { id: string }[] };
  assert.deepEqual(
    value.records.map((row) => row.id),
    ["105"],
  );
  assert.equal(f.home.calls.filter((call) => call.path.includes("/usage/records?")).length, 1);
  for (const call of f.home.calls.filter((call) => call.path.includes("/usage/records?"))) {
    const query = new URL(`https://home.example${call.path}`).searchParams;
    assert.equal(query.has("parent_session_id"), false);
    assert.equal(query.has("root_session_id"), false);
  }
});

for (const [suffix, count] of [
  ["", 20],
  ["&limit=3", 3],
  ["&limit=999", 200],
] as const) {
  test(`usage respects its default and capped limit for ${suffix || "the default"}`, async () => {
    const f = await fixture();
    f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.usage = Array.from({ length: 220 }, (_, i) => usageRow(String(i + 1), "own-account"));
    const response = await f.call(`/usage?session=fake-run${suffix}`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { records: unknown[] }).records.length, count);
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    assert.equal(new URL(`https://home.example${path}`).searchParams.get("limit"), "200");
  });
}

test("usage passes status to Home and excludes other outcomes before applying its limit", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["own-account"]);
  f.home.ignoreUsageFilters = true;
  f.home.usage = [
    usageRow("101", "own-account", "b2dff7a4-658d-811d-ab12-7d8bbe4e6157", 17, "failed"),
    usageRow("102", "own-account"),
    usageRow("103", "own-account"),
  ];
  const response = await f.call("/usage?session=fake-run&limit=1&status=success");
  assert.equal(response.status, 200);
  assert.deepEqual(
    ((await response.json()) as { records: { id: string }[] }).records.map((row) => row.id),
    ["102"],
  );
  for (const call of f.home.calls.filter((call) => call.path.includes("/usage/records?"))) {
    assert.equal(new URL(`https://home.example${call.path}`).searchParams.get("status"), "success");
  }
});

for (const [query, expected] of [
  ["key=17", ["101", "102"]],
  ["session=fake-run&key=17", ["101"]],
  ["key=18", []],
] as const) {
  test(`usage key filter ${query} is exact and remains scoped to the pool`, async () => {
    const f = await fixture();
    f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.addGroup("pool-b", 2, ["other-account"]);
    f.home.usage = [
      usageRow("101", "own-account"),
      usageRow("102", "own-account", "header:another-run"),
      usageRow("103", "other-account", "b2dff7a4-658d-811d-ab12-7d8bbe4e6157", 18),
    ];
    const response = await f.call(`/usage?${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual(
      ((await response.json()) as { records: { id: string }[] }).records.map((row) => row.id),
      expected,
    );
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    const params = new URL(`https://home.example${path}`).searchParams;
    assert.equal(params.get("client_key_id"), query.endsWith("18") ? "18" : "17");
    assert.equal(params.has("client_key"), false);
    assert.equal(params.has("session_id"), query.includes("session="));
  });
}

test("usage checks the numeric client key id again when Home returns wider results", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["own-account"]);
  f.home.ignoreUsageFilters = true;
  f.home.usage = [
    usageRow("100", "own-account", "b2dff7a4-658d-811d-ab12-7d8bbe4e6157", 117),
    usageRow("101", "own-account"),
  ];
  const response = await f.call("/usage?key=17&limit=1");
  assert.equal(response.status, 200);
  assert.deepEqual(
    ((await response.json()) as { records: { id: string }[] }).records.map((row) => row.id),
    ["101"],
  );
});

test("usage requires session or key and rejects invalid limits and secret-shaped keys locally", async () => {
  const f = await fixture();
  for (const query of [
    "",
    "session=",
    "status=success",
    "key=",
    "key=0",
    "key=-1",
    "key=1.5",
    "key=obviously-fake-secret",
    "key=9007199254740992",
    "session=fake&limit=0",
    "session=fake&limit=-1",
    "session=fake&limit=1.5",
    "session=fake&limit=nope",
    `session=${"x".repeat(257)}`,
  ]) {
    await error(await f.call(`/usage?${query}`), "invalid_query");
  }
  assert.equal(f.home.calls.length, 0);
  assert.equal(f.storage.gets, 0);
});

test("usage bypasses an in-flight attribution request without touching its storage", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["own-account"]);
  f.home.usage = [usageRow("101", "own-account")];
  const started = (await (await f.acquire("start")).json()) as { session: string };
  const entered = deferred();
  const release = deferred();
  f.home.override = async (path) => {
    if (path.includes("/oauth/status")) {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const pending = f.acquire("status", { session: started.session });
  await entered.promise;
  const before = { reads: f.storage.gets, writes: f.storage.puts, alarms: f.storage.alarmReads };
  const read = f.call("/usage?key=17");
  try {
    await withoutWaitingForGate(read);
    const response = await read;
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { records: unknown[] }).records.length, 1);
    assert.deepEqual(
      { reads: f.storage.gets, writes: f.storage.puts, alarms: f.storage.alarmReads },
      before,
    );
  } finally {
    release.resolve();
    await pending;
  }
});

test("usage mirrors the pinned node's UTF-8 bound for a long wire session id", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["own-account"]);
  const wire = "é".repeat(128);
  const stored = "d16a0b06-7664-8b67-ac0d-efa067bd7bed";
  f.home.usage = [usageRow("101", "own-account", stored)];
  const response = await f.call(`/usage?session=${encodeURIComponent(wire)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    ((await response.json()) as { records: { id: string }[] }).records.map((row) => row.id),
    ["101"],
  );
  const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
  assert.equal(new URL(`https://home.example${path}`).searchParams.get("session_id"), stored);
});

// Generated by running the pinned v8.0.40 Go NormalizeExplicitID,
// BoundSessionIdentity and NormalizeToCanonicalUUID functions, in that order.
const usageSessionVectors = [
  ["run", "f155da03-d152-8924-be25-2d100c00c1d7"],
  ["550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000"],
  ["derived:ctx:v1:run", "f155da03-d152-8924-be25-2d100c00c1d7"],
  ["custom:550E8400-E29B-41D4-A716-446655440000", "550e8400-e29b-41d4-a716-446655440000"],
  ["outer:inner:550E8400-E29B-41D4-A716-446655440000", "02639ad8-c182-8e20-a7cb-707e08105f0b"],
  ["é".repeat(128), "d16a0b06-7664-8b67-ac0d-efa067bd7bed"],
] as const;
for (const [wire, expected] of usageSessionVectors) {
  test(`usage canonical session matches pinned Go vector ${wire.slice(0, 55)}`, async () => {
    const f = await fixture();
    f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.usage = [usageRow("101", "own-account", expected)];
    const response = await f.call(`/usage?session=${encodeURIComponent(wire)}`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { records: unknown[] }).records.length, 1);
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    assert.equal(new URL(`https://home.example${path}`).searchParams.get("session_id"), expected);
  });
}

test("usage rejects controls before trimming a wire session", async () => {
  const f = await fixture();
  for (const wire of ["run\n", "\trun", "run\r", "run\u0085", "run\0", "header:"]) {
    await error(await f.call(`/usage?session=${encodeURIComponent(wire)}&key=17`), "invalid_query");
  }
  assert.equal(f.home.calls.length, 0);
});

for (const [input, canonical, outcome, code] of [
  ["success", "success", "success", 200],
  ["succeeded", "success", "success", 200],
  ["ok", "success", "success", 200],
  ["failed", "failed", "failed", 503],
  ["failure", "failed", "failed", 503],
  ["error", "failed", "failed", 503],
  ["200", "200", "success", 200],
  ["503", "503", "failed", 503],
] as const) {
  test(`usage status ${input} is sent as ${canonical} and preserves matching rows`, async () => {
    const f = await fixture();
    f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.usage = [
      { ...usageRow("101", "own-account", undefined, 17, outcome), status_code: code },
    ];
    const response = await f.call(`/usage?key=17&status=${input}`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { records: unknown[] }).records.length, 1);
    const path = f.home.calls.find((call) => call.path.includes("/usage/records?"))!.path;
    assert.equal(new URL(`https://home.example${path}`).searchParams.get("status"), canonical);
  });
}

test("usage rejects unknown outcomes and non-plain HTTP status codes locally", async () => {
  const f = await fixture();
  for (const status of ["", "unknown", "+200", "0200", "200.0", "200x", "99", "600", "-200"]) {
    await error(
      await f.call(`/usage?key=17&status=${encodeURIComponent(status)}`),
      "invalid_query",
    );
  }
  assert.equal(f.home.calls.length, 0);
});

for (const ownAtBoundary of [false, true]) {
  test(`usage scans at most five 200-row pages and returns matches found, boundary=${ownAtBoundary}`, async () => {
    const f = await fixture();
    f.home.addGroup("pool-a", 1, ["own-account"]);
    f.home.addGroup("pool-b", 2, ["other-account"]);
    f.home.usage = Array.from({ length: 1_001 }, (_, i) =>
      usageRow(
        String(i + 1),
        i === 0 || (ownAtBoundary && i === 999) || i === 1_000 ? "own-account" : "other-account",
      ),
    );
    const response = await f.call("/usage?session=fake-run&limit=20");
    assert.equal(response.status, 200);
    assert.deepEqual(
      ((await response.json()) as { records: { id: string }[] }).records.map((row) => row.id),
      ownAtBoundary ? ["1", "1000"] : ["1"],
    );
    const calls = f.home.calls.filter((call) => call.path.includes("/usage/records?"));
    assert.equal(calls.length, 5);
    assert.deepEqual(
      calls.map((call) => {
        const query = new URL(`https://home.example${call.path}`).searchParams;
        assert.equal(query.get("limit"), "200");
        return Number(query.get("offset"));
      }),
      [0, 200, 400, 600, 800],
    );
  });
}

test("observation routes deny members before reading Home or attribution", async () => {
  const f = await fixture();
  for (const [path, method] of [
    ["/accounts/a/observations", "GET"],
    ["/accounts/a/observations/refresh", "POST"],
  ]) {
    await error(await f.call(path!, { method, owner: false }), "not_owner", 403);
  }
  assert.equal(f.home.calls.length, 0);
  assert.equal(f.storage.gets, 0);
  assert.equal(f.storage.puts, 0);
});

test("observation routes keep raw diagnostics private and preserve quota on runtime rejection", async () => {
  const f = await fixture();
  f.home.addFile("a");
  f.home.addGroup("pool-a", 10, ["a"]);
  f.home.files.set("a", { ...f.home.files.get("a"), status: "error" });
  const at = f.deps.now().toISOString();
  f.home.override = (path) => {
    if (path.endsWith("/quota/credentials/a"))
      return Response.json({
        credential: { credential_id: "a", plan: { name: "Pro", premium: true } },
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            unit: "requests",
            remaining: 70,
            limit: 100,
            remaining_ratio: 0.7,
            observed_at: at,
          },
        ],
        collection: { status: "success", freshness: "fresh", observed_at: at, last_attempt_at: at },
        private_diagnostic: "never-expose-this-body",
      });
    if (path.endsWith("/credentials/a/model-states"))
      return Response.json({
        credential: {
          credential_id: "a",
          refresh_blocked: true,
          last_error: { http_status: 401, message: "never-expose-this-body" },
        },
      });
    return undefined;
  };
  const response = await f.call("/accounts/a/observations");
  assert.equal(response.status, 200, await response.clone().text());
  const serialized = await response.text();
  assert.equal(serialized.includes("never-expose-this-body"), false);
  const result = JSON.parse(serialized);
  assert.equal(result.account.credentialFailure, "unauthorized");
  assert.equal(result.observation.observation.plan.label, "Pro");
  assert.deepEqual(
    result.observation.observation.windows.map((w: { id: string }) => w.id),
    ["weekly"],
  );
  assert.equal(result.observation.observation.windows[0].measure.limit, 100);
  await error(await f.call("/accounts/a/observations", { pool: "pool-b" }), "not_found", 404);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 0);
  assert.equal(f.storage.puts, 0, "observing never persists or expires OAuth attribution");
});

test("explicit observation refresh coalesces collection and preserves its persistent cap", async () => {
  const f = await fixture();
  f.home.addFile("a");
  f.home.addGroup("pool-a", 10, ["a"]);
  let collected = false;
  f.home.override = (path) => {
    if (path.endsWith("/quota/collect")) {
      collected = true;
      return Response.json({ accepted: 1, running: true }, { status: 202 });
    }
    if (path.endsWith("/quota/credentials/a"))
      return Response.json({
        credential: { credential_id: "a" },
        windows: [
          {
            id: "weekly",
            label: "Weekly",
            unit: "requests",
            remaining: 12,
            limit: 20,
            observed_at: f.deps.now().toISOString(),
          },
        ],
        collection: {
          status: collected ? "success" : "idle",
          freshness: collected ? "fresh" : "never",
          observed_at: collected ? f.deps.now().toISOString() : null,
          last_attempt_at: collected ? f.deps.now().toISOString() : null,
        },
      });
    return undefined;
  };
  const responses = await Promise.all(
    Array.from({ length: 4 }, () => f.call("/accounts/a/observations/refresh", { method: "POST" })),
  );
  for (const response of responses) {
    assert.equal(response.status, 200, await response.clone().text());
    const result = (await response.json()) as {
      observation: { observation: { windows: { id: string }[] } };
    };
    assert.deepEqual(
      result.observation.observation.windows.map((window) => window.id),
      ["weekly"],
    );
  }
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 1);
  f.restart();
  assert.equal((await f.call("/accounts/a/observations/refresh", { method: "POST" })).status, 200);
  assert.equal(f.home.calls.filter((call) => call.path.endsWith("/quota/collect")).length, 1);
});

test("native removal records owner intent after deletion acknowledgement and hides it from members", async () => {
  const f = await fixture(["fake-member"]);
  f.home.addFile("deliberate");
  f.home.addGroup("pool-a", 10, ["deliberate"]);
  assert.equal(
    (await f.call("/accounts/deliberate", { method: "DELETE", owner: false })).status,
    403,
  );
  assert.equal((await f.call("/accounts/deliberate", { method: "DELETE" })).status, 200);
  const own = (await (await f.call("/pool")).json()) as PoolView;
  assert.deepEqual(own.removals, {
    since: null,
    items: [{ account: "deliberate", actor: "fake-owner", at: "2026-01-01T00:00:00.000Z" }],
  });
  const member = (await (await f.call("/pool", { owner: false })).json()) as PoolView;
  assert.equal(Object.hasOwn(member, "removals"), false);
  f.restart();
  assert.deepEqual(((await (await f.call("/pool")).json()) as PoolView).removals, own.removals);
});

test("a refused credential deletion cannot create a removal-intent receipt", async () => {
  const f = await fixture();
  f.home.addFile("retained");
  f.home.addGroup("pool-a", 10, ["retained"]);
  f.home.override = (path, init) =>
    path.includes("/credentials?id=retained") && init?.method === "DELETE"
      ? Response.json({}, { status: 500 })
      : undefined;
  assert.equal((await f.call("/accounts/retained", { method: "DELETE" })).status, 503);
  const view = (await (await f.call("/pool")).json()) as PoolView;
  assert.deepEqual(view.removals, { since: null, items: [] });
  assert.deepEqual(
    view.accounts.map((account) => account.id),
    ["retained"],
  );
});

test("native removal intent follows observations made while deletion awaits acknowledgement", async () => {
  const f = await fixture();
  f.home.addFile("delayed");
  f.home.addGroup("pool-a", 10, ["delayed"]);
  const entered = deferred(),
    release = deferred();
  f.home.override = async (path, init) => {
    if (path.includes("/credentials?id=delayed") && init?.method === "DELETE") {
      entered.resolve();
      await release.promise;
    }
    return undefined;
  };
  const removing = f.call("/accounts/delayed", { method: "DELETE" });
  await entered.promise;
  let observedAt: number;
  try {
    f.advance(1000);
    const during = (await (await f.call("/pool")).json()) as PoolView;
    assert.equal(during.accounts[0]!.id, "delayed");
    observedAt = f.deps.now().getTime();
    f.advance(1000);
  } finally {
    release.resolve();
  }
  assert.equal((await removing).status, 200);
  const after = (await (await f.call("/pool")).json()) as PoolView;
  assert.equal(after.accounts.length, 0);
  assert.ok(Date.parse(after.removals!.items[0]!.at) >= observedAt);
  assert.equal(after.removals!.items[0]!.at, f.deps.now().toISOString());
});

test("the alarm retains an unattended global result across eviction without attaching any pool", async () => {
  const f = await fixture();
  const startedResponse = await f.acquire("start");
  assert.equal(startedResponse.status, 200);
  const started = (await startedResponse.json()) as { session: string };
  const nativeState = [...f.home.sessions.keys()][0]!;
  assert.equal(f.storage.alarm, f.deps.now().getTime() + 30_000);
  f.home.addFile("unattended-account");
  f.home.sessions.set(nativeState, { provider, status: "ok", auth_ids: ["unattended-account"] });
  f.advance(30_000);
  f.restart();
  await f.expire();
  f.home.sessions.clear();
  f.restart();
  const before = f.home.calls.length;
  const response = await f.acquire("status", { session: started.session });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: "connected", ref: "unattended-account" });
  assert.equal(f.home.calls.length, before, "a lost Home result is served from the durable answer");
  assert.equal(f.home.members.length, 0);
});

test("removing an account cannot return its retained membership after acknowledgement", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["removed"]);
  f.home.addFile("removed");
  await f.call("/pool");
  assert.equal((await f.call("/accounts/removed", { method: "DELETE" })).status, 200);
  f.restart();
  const after = (await (await f.call("/pool")).json()) as PoolView;
  assert.equal(after.reading?.source, "live");
  assert.deepEqual(after.accounts, []);
});

test("pausing an account invalidates credential state in the retained view", async () => {
  const f = await fixture();
  f.home.addGroup("pool-a", 1, ["paused"]);
  f.home.addFile("paused", "codex");
  await f.call("/pool");
  f.home.override = (path, init) => {
    if (!path.endsWith("/credentials/status")) return undefined;
    assert.equal(init?.method, "PATCH");
    f.home.files.get("paused")!.disabled = true;
    return Response.json({ status: "ok", disabled: true });
  };
  assert.equal((await f.call("/accounts/paused/pause", { method: "POST" })).status, 200);
  const after = (await (await f.call("/pool")).json()) as PoolView;
  assert.equal(after.reading?.source, "live");
  assert.equal(after.accounts[0]!.state, "disabled");
});
