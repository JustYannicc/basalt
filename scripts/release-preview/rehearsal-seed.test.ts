import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RehearsalRefusal,
  rehearsalRequestId,
  seedRehearsalPools,
  verifyRehearsalPolicies,
  type RehearsalPolicy,
} from "./rehearsal-seed.ts";

const origin = "https://preview.example";
const accounts = [
  { id: "acc_openai", requirement: "openai" },
  { id: "acc_anthropic", requirement: "anthropic" },
] as const;
const input = {
  origin,
  email: "acceptance@example.test",
  password: "fixture-password-never-log",
  organizationId: "org_fixture",
  poolAppId: "app_preview",
  accounts,
};
const prefix = "/api/organizations/org_fixture";
const credentials = {
  modelUrl: origin,
  modelKey: "fixture-model-key",
  toolsUrl: `${origin}/mcp`,
  toolsToken: "fixture-tools-token",
};
const claim = "ab".repeat(32);

type Call = { method: string; path: string; cookie: string | null; body: unknown };
type Host = { previewAccounts?: string[]; created?: (index: number) => Response };

/** A stand-in for the product routes the preview scripts already use. */
function fakeHost(options: Host = {}) {
  const calls: Call[] = [];
  const links = new Map<string, Set<string>>();
  let created = 0;
  const fetch = (async (url: URL, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, cookie: new Headers(init.headers).get("cookie"), body });
    if (path === "/api/auth/sign-in/email")
      return Response.json(
        { user: { id: "user_fixture" } },
        { headers: { "set-cookie": "session=fixture; Path=/; HttpOnly" } },
      );
    if (path === "/api/auth/sign-out") return Response.json({});
    if (path === "/api/auth/get-session") return new Response(null, { status: 401 });
    if (path === `${prefix}/pools`) {
      const response = options.created?.(created);
      if (response) return response;
      return Response.json({ id: `app_pool${created++}`, reused: false });
    }
    if (path === `${prefix}/accounts/acc_openai` || path === `${prefix}/accounts/acc_anthropic`)
      return Response.json({});
    const app = /^\/api\/organizations\/org_fixture\/apps\/([^/]+)\/(.*)$/.exec(path);
    if (!app) return new Response(null, { status: 404 });
    const [, pool, rest] = app as unknown as [string, string, string];
    const selected = links.get(pool) ?? new Set<string>();
    links.set(pool, selected);
    if (rest === "data/query" && body.name === "view") {
      const ids = pool === "app_preview" ? (options.previewAccounts ?? []) : [...selected];
      return Response.json({
        ok: true,
        value: { isOwner: true, accounts: ids.map((id) => ({ id })) },
      });
    }
    if (rest === "data/query" && body.name === "computerContext")
      return Response.json({ ok: true, value: { href: `${origin}/setup#intent=intent-${pool}` } });
    const link = /^accounts\/app\/(openai|anthropic)\/(acc_\w+)$/.exec(rest);
    if (link && method === "PUT") {
      selected.add(link[2]!);
      return new Response(null, { status: 204 });
    }
    if (rest === "accounts/app")
      return Response.json(
        accounts
          .filter((a) => selected.has(a.id))
          .map((a) => ({ requirement: a.requirement, account: { id: a.id } })),
      );
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
  const setupFetch = (async (url: URL, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/setup/v1/links") {
      calls.push({
        method: "POST",
        path,
        cookie: new Headers(init.headers).get("cookie"),
        body: JSON.parse(String(init.body)),
      });
      return Response.json({
        computerId: "cmp_fixture",
        prompt: `Open ${origin}/setup/claim/${claim}`,
      });
    }
    if (path === `/setup/claim/${claim}`) {
      calls.push({
        method: "GET",
        path,
        cookie: new Headers(init.headers).get("cookie"),
        body: undefined,
      });
      return Response.json({
        version: 1,
        brand: {
          name: "Preview",
          mcpServerName: "preview",
          setup: { id: "setup", marker: "setup" },
        },
        credentials,
        instructions: "",
      });
    }
    return fetch(url, init);
  }) as typeof globalThis.fetch;
  return { calls, links, fetch: setupFetch };
}

test("seeding leaves the preview pool empty, adds empty pools and one clean pool with access", async () => {
  const host = fakeHost();
  const seed = await seedRehearsalPools({ ...input, emptyCount: 5, fetch: host.fetch });
  assert.deepEqual(seed, {
    cleanPool: "app_pool0",
    emptyPools: ["app_pool1", "app_pool2", "app_pool3", "app_pool4", "app_pool5"],
    access: { computerId: "cmp_fixture", modelUrl: origin, modelKey: "fixture-model-key" },
  });
  const creations = host.calls.filter((call) => call.path === `${prefix}/pools`);
  assert.deepEqual(
    creations.map((call) => call.body),
    [0, 1, 2, 3, 4, 5].map((index) => ({
      name: index === 0 ? "Rehearsal clean pool" : `Rehearsal empty pool ${index}`,
      requestId: rehearsalRequestId("org_fixture", index),
      newInstance: true,
    })),
  );
  assert.ok(creations.every((call) => call.method === "POST" && call.cookie === "session=fixture"));
  assert.deepEqual([...host.links.get("app_pool0")!].sort(), ["acc_anthropic", "acc_openai"]);
  for (const pool of ["app_preview", ...seed.emptyPools])
    assert.equal(host.links.get(pool)?.size ?? 0, 0, pool);
  const writes = host.calls.filter((call) => call.method === "PUT").map((call) => call.path);
  assert.ok(writes.every((path) => path.startsWith(`${prefix}/apps/app_pool0/`)));
  const link = host.calls.find((call) => call.path === "/setup/v1/links")!;
  assert.equal((link.body as { intent: string }).intent, "intent-app_pool0");
  const claimCall = host.calls.find((call) => call.path.startsWith("/setup/claim/"))!;
  assert.equal(claimCall.cookie, null);
  assert.equal(host.calls.filter((call) => call.path === "/api/auth/sign-out").length, 2);
});

test("request ids are stable v4 UUIDs so a retried job replays the same pools", () => {
  const id = rehearsalRequestId("org_fixture", 1);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(rehearsalRequestId("org_fixture", 1), id);
  assert.notEqual(rehearsalRequestId("org_fixture", 2), id);
  assert.notEqual(rehearsalRequestId("org_other", 1), id);
});

test("seeding refuses a used preview pool, a failed or reused creation and bad accounts", async () => {
  const cases: Array<[Host, RegExp]> = [
    [{ previewAccounts: ["acc_openai"] }, /was not empty/],
    [
      { created: () => Response.json({ _tag: "PoolCreationUnavailable" }, { status: 503 }) },
      /HTTP 503/,
    ],
    [{ created: () => Response.json({ name: "no id" }) }, /did not return an app id/],
    [
      { created: () => Response.json({ id: "app_preview", reused: true }) },
      /reused an existing pool/,
    ],
    [
      { created: () => Response.json({ id: "app_same", reused: false }) },
      /reused an existing pool/,
    ],
  ];
  for (const [options, message] of cases) {
    const host = fakeHost(options);
    await assert.rejects(
      seedRehearsalPools({ ...input, emptyCount: 2, fetch: host.fetch }),
      message,
    );
    assert.equal(host.calls.filter((call) => call.method === "PUT").length, 0);
  }
  const host = fakeHost();
  await assert.rejects(
    seedRehearsalPools({ ...input, emptyCount: -1, fetch: host.fetch }),
    /between/,
  );
  await assert.rejects(
    seedRehearsalPools({ ...input, accounts: [accounts[0]], fetch: host.fetch }),
    /OpenAI and Anthropic/,
  );
  assert.equal(host.calls.length, 0);
});

const policy = (pool: string, patch: Partial<RehearsalPolicy> = {}): RehearsalPolicy => ({
  pool,
  organization: "org_fixture",
  revision: 3,
  expiresAt: 1_000,
  accounts: [],
  dirty: true,
  ...patch,
});
const empty = ["app_preview", "app_pool1", "app_pool2", "app_pool3", "app_pool4", "app_pool5"];
const production = () => [
  policy("app_pool0", { dirty: false, accounts: ["auth-a", "auth-b"] }),
  ...empty.map((pool) => policy(pool)),
];
const at = (pool: string, patch: Partial<RehearsalPolicy>) =>
  production().map((entry) => (entry.pool === pool ? { ...entry, ...patch } : entry));

test("the verifier accepts one clean pool with accounts and six dirty empty pools", () => {
  verifyRehearsalPolicies(production(), { cleanPool: "app_pool0" });
  verifyRehearsalPolicies(production().reverse(), { cleanPool: "app_pool0", emptyPools: empty });
});

test("the verifier refuses any other policy shape", () => {
  const refusals: Array<[RehearsalPolicy[], RegExp, string[]?]> = [
    [production().slice(0, 6), /expected 7 policies, found 6/],
    [[...production(), policy("app_extra")], /expected 7 policies, found 8/],
    [[...production().slice(0, 6), policy("app_pool1")], /more than one policy/],
    [at("app_pool0", { dirty: true }), /clean pool is dirty/],
    [at("app_pool0", { accounts: [] }), /clean pool has no accounts/],
    [at("app_pool0", { pool: "app_other" }), /clean pool has no policy/],
    [at("app_preview", { dirty: false }), /app_preview is not dirty/],
    [at("app_pool3", { accounts: ["auth-c"] }), /app_pool3 has accounts/],
    [at("app_pool4", { organization: "org_b" }), /one organization, found 2/],
    [production(), /not the seeded pools/, ["app_pool1", "app_elsewhere"]],
  ];
  for (const [policies, message, emptyPools] of refusals)
    assert.throws(
      () => verifyRehearsalPolicies(policies, { cleanPool: "app_pool0", emptyPools }),
      (error) => error instanceof RehearsalRefusal && message.test(error.message),
    );
});

test("an infra-only seed's clean pool must hold no accounts, and is refused with any", () => {
  const infra = at("app_pool0", { accounts: [] });
  verifyRehearsalPolicies(infra, { cleanPool: "app_pool0", emptyPools: empty, infraOnly: true });
  assert.throws(
    () => verifyRehearsalPolicies(production(), { cleanPool: "app_pool0", infraOnly: true }),
    (error) =>
      error instanceof RehearsalRefusal && /infra-only clean pool has accounts/.test(error.message),
  );
  // Every other check still runs: an infra-only clean pool that is dirty is still refused.
  assert.throws(
    () =>
      verifyRehearsalPolicies(at("app_pool0", { accounts: [], dirty: true }), {
        cleanPool: "app_pool0",
        infraOnly: true,
      }),
    (error) => error instanceof RehearsalRefusal && /clean pool is dirty/.test(error.message),
  );
});

test("an infra-only seed creates the same pools with no accounts and claims no traffic computer", async () => {
  const host = fakeHost();
  const seed = await seedRehearsalPools({
    ...input,
    accounts: [],
    infraOnly: true,
    emptyCount: 2,
    fetch: host.fetch,
  });
  assert.deepEqual(seed, { cleanPool: "app_pool0", emptyPools: ["app_pool1", "app_pool2"] });
  for (const pool of ["app_preview", "app_pool0", ...seed.emptyPools])
    assert.equal(host.links.get(pool)?.size ?? 0, 0, pool);
  assert.ok(host.calls.every((call) => call.method !== "PUT" && !call.path.includes("computer")));
  await assert.rejects(
    seedRehearsalPools({ ...input, infraOnly: true, emptyCount: 2, fetch: host.fetch }),
    /no accounts/,
  );
});
