import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cloudflareArtifactsApi,
  deleteEuNamespace,
  ensureEuNamespace,
  stageNamespaces,
  vaultNamespace,
  type ArtifactsApi,
} from "./ensure-artifacts.ts";

function fixture(
  initial: {
    namespaces?: Array<{ namespace: string; jurisdiction: string }>;
    repos?: string[];
  } = {},
) {
  const calls: string[] = [];
  const namespaces = [...(initial.namespaces ?? [])];
  const repos = [...(initial.repos ?? [])];
  const api: ArtifactsApi = {
    async listNamespaces(cursor) {
      calls.push(`namespaces:${cursor ?? ""}`);
      return cursor
        ? { result: [] }
        : { result: namespaces.map((namespace) => ({ ...namespace })) };
    },
    async createNamespace(name) {
      calls.push(`create:${name}`);
      const namespace = { namespace: name, jurisdiction: "eu" };
      namespaces.push(namespace);
      return namespace;
    },
    async deleteNamespace(name) {
      calls.push(`delete-namespace:${name}`);
      const index = namespaces.findIndex((item) => item.namespace === name);
      if (index >= 0) namespaces.splice(index, 1);
    },
    async listRepositories(namespace, cursor) {
      calls.push(`repos:${namespace}:${cursor ?? ""}`);
      return cursor ? { result: [] } : { result: repos.map((name) => ({ name })) };
    },
    async deleteRepository(namespace, name) {
      calls.push(`delete-repo:${namespace}:${name}`);
      const index = repos.indexOf(name);
      if (index >= 0) repos.splice(index, 1);
    },
    async listRepositoryTokens(namespace, name, cursor) {
      calls.push(`tokens:${namespace}:${name}:${cursor ?? ""}`);
      return { result: [{ id: `${name}-token` }] };
    },
    async deleteToken(namespace, token) {
      calls.push(`delete-token:${namespace}:${token}`);
    },
  };
  return { api, calls, namespaces, repos };
}

test("refuses an existing namespace outside the EU without mutating it", async () => {
  const { api, calls } = fixture({
    namespaces: [{ namespace: "basalt-preview-pr-1419-apps", jurisdiction: "unrestricted" }],
  });
  await assert.rejects(
    ensureEuNamespace(api, "basalt-preview-pr-1419-apps"),
    /immutable EU jurisdiction/,
  );
  assert.deepEqual(calls, ["namespaces:"]);
});

test("checks every page before creating a missing EU namespace", async () => {
  const { api, calls } = fixture();
  api.listNamespaces = async (cursor) => {
    calls.push(`namespaces:${cursor ?? ""}`);
    return cursor ? { result: [] } : { result: [], result_info: { cursor: "next" } };
  };
  await ensureEuNamespace(api, "basalt-preview-pr-1419-apps");
  assert.deepEqual(calls, ["namespaces:", "namespaces:next", "create:basalt-preview-pr-1419-apps"]);
});

test("deletes every repository before deleting and verifying the namespace", async () => {
  const { api, calls } = fixture({
    namespaces: [{ namespace: "basalt-preview-pr-1419-apps", jurisdiction: "eu" }],
    repos: ["apps", "workspace"],
  });
  await deleteEuNamespace(api, "basalt-preview-pr-1419-apps", { wait: async () => {} });
  assert.deepEqual(calls, [
    "namespaces:",
    "repos:basalt-preview-pr-1419-apps:",
    "tokens:basalt-preview-pr-1419-apps:apps:",
    "delete-token:basalt-preview-pr-1419-apps:apps-token",
    "delete-repo:basalt-preview-pr-1419-apps:apps",
    "tokens:basalt-preview-pr-1419-apps:workspace:",
    "delete-token:basalt-preview-pr-1419-apps:workspace-token",
    "delete-repo:basalt-preview-pr-1419-apps:workspace",
    "repos:basalt-preview-pr-1419-apps:",
    "delete-namespace:basalt-preview-pr-1419-apps",
    "namespaces:",
  ]);
});

test("deleting an already absent namespace is idempotent", async () => {
  const { api, calls } = fixture();
  await deleteEuNamespace(api, "basalt-preview-pr-1419-apps");
  assert.deepEqual(calls, ["namespaces:"]);
});

test("namespace removal fails while provider readback still finds repositories", async () => {
  const { api } = fixture({
    namespaces: [{ namespace: "basalt-preview-pr-1419-apps", jurisdiction: "eu" }],
    repos: ["still-here"],
  });
  api.deleteRepository = async () => {};
  await assert.rejects(
    deleteEuNamespace(api, "basalt-preview-pr-1419-apps", {
      attempts: 2,
      delayMs: 0,
      wait: async () => {},
    }),
    /repositories are still present/,
  );
});

test("the HTTP client reads Cloudflare's paginated list envelope before creating an EU namespace", async () => {
  // Shapes from the Artifacts REST API reference: list routes return `result` items and a `result_info` cursor.
  const requests: string[] = [];
  const pages: Record<string, unknown> = {
    "": {
      result: [{ namespace: "other", jurisdiction: "eu" }],
      success: true,
      errors: [],
      messages: [],
      result_info: { cursor: "page-2", per_page: 1, count: 1 },
    },
    "page-2": {
      result: [],
      success: true,
      errors: [],
      messages: [],
      result_info: { cursor: "", per_page: 1, count: 0 },
    },
  };
  const api = cloudflareArtifactsApi("account", "fixture-token", async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method} ${url.pathname}${url.search}`);
    if (init?.method === "GET") return Response.json(pages[url.searchParams.get("cursor") ?? ""]);
    return Response.json({
      result: { namespace: "basalt-apps", jurisdiction: "eu" },
      success: true,
      errors: [],
      messages: [],
    });
  });
  await ensureEuNamespace(api, "basalt-apps");
  assert.deepEqual(requests, [
    "GET /client/v4/accounts/account/artifacts/namespaces?limit=200",
    "GET /client/v4/accounts/account/artifacts/namespaces?limit=200&cursor=page-2",
    "POST /client/v4/accounts/account/artifacts/namespaces",
  ]);
});

test("the HTTP client pages repository tokens by number and stops after the last page", async () => {
  const requests: string[] = [];
  const api = cloudflareArtifactsApi("account", "fixture-token", async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    const page = Number(url.searchParams.get("page"));
    return Response.json({
      result: [{ id: `token-${page}` }],
      success: true,
      errors: [],
      messages: [],
      result_info: { page, per_page: 100, total_pages: 2, count: 1, total_count: 2 },
    });
  });
  const first = await api.listRepositoryTokens("ns", "repo");
  assert.deepEqual(first, { result: [{ id: "token-1" }], result_info: { cursor: "2" } });
  const second = await api.listRepositoryTokens("ns", "repo", "2");
  assert.deepEqual(second, { result: [{ id: "token-2" }], result_info: { cursor: undefined } });
  assert.deepEqual(requests, [
    "/client/v4/accounts/account/artifacts/namespaces/ns/repos/repo/tokens?per_page=100&page=1",
    "/client/v4/accounts/account/artifacts/namespaces/ns/repos/repo/tokens?per_page=100&page=2",
  ]);
  const unpaged = cloudflareArtifactsApi("account", "fixture-token", async () =>
    Response.json({ result: [], success: true, errors: [], messages: [] }),
  );
  await assert.rejects(unpaged.listRepositoryTokens("ns", "repo"), /no page count/);
});

test("a listing that keeps issuing fresh cursors stops instead of hanging the deploy", async () => {
  let reads = 0;
  const api = cloudflareArtifactsApi("account", "fixture-token", async () => {
    reads += 1;
    return Response.json({
      result: [],
      success: true,
      errors: [],
      messages: [],
      result_info: { cursor: `fresh-${reads}` },
    });
  });
  await assert.rejects(ensureEuNamespace(api, "basalt-apps"), /pagination did not end/);
  assert.equal(reads, 1000);
});

test("403 diagnostics keep codes, Ray and rate limits without secrets or a retry", async () => {
  const secret = "fixture-secret-token-do-not-log";
  const ray = "0123456789abcdef-ABC";
  let requests = 0;
  const api = cloudflareArtifactsApi("account", secret, async () => {
    requests++;
    return Response.json(
      {
        success: false,
        errors: [{ code: 10000, message: secret }, { code: 9109, secret }, { code: secret }],
        secret,
        messages: [secret],
        result: { token: secret },
      },
      {
        status: 403,
        headers: {
          "cf-ray": ray,
          "cf-mitigated": "challenge",
          "retry-after": "30",
          ratelimit: `"${secret}";r=0;t=30`,
          "ratelimit-policy": '"burst";q=100;w=60',
          "x-ratelimit-limit": "100",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1234567890",
          authorization: `Bearer ${secret}`,
          "cf-access-jwt-assertion": secret,
          "set-cookie": secret,
        },
      },
    );
  });
  await assert.rejects(ensureEuNamespace(api, "basalt-apps"), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Cloudflare Artifacts list failed with HTTP 403/);
    assert.match(error.message, /"codes":\[10000,9109\]/);
    for (const value of [
      ray,
      '"cf-mitigated":"challenge"',
      '"retry-after":"30"',
      '"ratelimit":"r=0;t=30"',
      '"ratelimit-policy":"q=100;w=60"',
      '"x-ratelimit-limit":"100"',
      '"x-ratelimit-remaining":"0"',
      '"x-ratelimit-reset":"1234567890"',
    ])
      assert.ok(error.message.includes(value), value);
    for (const value of [
      secret,
      "authorization",
      "cf-access-jwt-assertion",
      "set-cookie",
      "messages",
      '"secret"',
    ])
      assert.ok(!error.message.includes(value), value);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(requests, 1);
});

test("invalid error bodies and header values cannot replace or contaminate the HTTP failure", async () => {
  const secret = "fixture-secret-token-do-not-log";
  const api = cloudflareArtifactsApi(
    "account",
    secret,
    async () =>
      new Response(`<html>${secret}</html>`, {
        status: 403,
        headers: {
          "cf-ray": secret,
          "cf-mitigated": secret,
          "retry-after": secret,
          "x-ratelimit-reset": "1".repeat(11),
          ratelimit: `"default";r=${secret};t=30`,
          "ratelimit-policy": "1".repeat(257),
        },
      }),
  );
  await assert.rejects(api.listNamespaces(), {
    message:
      'Cloudflare Artifacts list failed with HTTP 403; diagnostics={"codes":[],"headers":{}}',
  });
});

test("oversized failure streams stop at 64 KiB and retain HTTP status and Ray", async () => {
  const cap = 64 * 1024;
  const ray = "0123456789abcdef-ABC";
  const prefix = new TextEncoder().encode('{"errors":[{"code":10000}]}');
  let consumed = 0;
  let cancelled = false;
  let requests = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = new Uint8Array(4096).fill(32);
        if (consumed === 0) chunk.set(prefix);
        consumed += chunk.byteLength;
        controller.enqueue(chunk);
        if (consumed === 1024 * 1024) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const api = cloudflareArtifactsApi("account", "fixture-token", async () => {
    requests++;
    return new Response(body, { status: 403, headers: { "cf-ray": ray } });
  });
  await assert.rejects(api.listNamespaces(), {
    message: `Cloudflare Artifacts list failed with HTTP 403; diagnostics={"codes":[],"headers":{"cf-ray":"${ray}"}}`,
  });
  assert.equal(consumed, cap);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(requests, 1);
});

test("Ray IDs with line breaks are omitted from failure diagnostics", async () => {
  for (const ray of [
    "0123456789abcdef-ABC\n",
    "0123456789abcdef-ABC\r\n",
    "01234567\n89abcdef-ABC",
  ]) {
    const response = Response.json({ errors: [{ code: 10000 }] }, { status: 403 });
    // Native Headers rejects or trims line breaks; inject a malformed header at the fetch boundary.
    response.headers.get = (name) => (name === "cf-ray" ? ray : null);
    const api = cloudflareArtifactsApi("account", "fixture-token", async () => response);
    await assert.rejects(api.listNamespaces(), {
      message:
        'Cloudflare Artifacts list failed with HTTP 403; diagnostics={"codes":[10000],"headers":{}}',
    });
  }
});

test("rejected API envelopes keep numeric codes without their messages", async () => {
  const api = cloudflareArtifactsApi("account", "fixture-token", async () =>
    Response.json({
      result: null,
      success: false,
      errors: [{ code: 10000, message: "fixture-secret-do-not-log" }],
    }),
  );
  await assert.rejects(api.listNamespaces(), {
    message: 'Cloudflare Artifacts list was rejected; diagnostics={"codes":[10000],"headers":{}}',
  });
});

test("every Artifacts operation bounds numeric codes and rejects 403 after one request", async () => {
  for (const operation of [
    (api: ArtifactsApi) => api.listNamespaces(),
    (api: ArtifactsApi) => api.createNamespace("ns"),
    (api: ArtifactsApi) => api.deleteNamespace("ns"),
    (api: ArtifactsApi) => api.listRepositories("ns"),
    (api: ArtifactsApi) => api.deleteRepository("ns", "repo"),
    (api: ArtifactsApi) => api.listRepositoryTokens("ns", "repo"),
    (api: ArtifactsApi) => api.deleteToken("ns", "fixture-token"),
  ]) {
    let requests = 0;
    const api = cloudflareArtifactsApi("account", "fixture-token", async () => {
      requests++;
      return Response.json(
        {
          errors: [
            { code: "123" },
            { code: -1 },
            { code: 1.5 },
            { code: 100_000_000 },
            ...Array.from({ length: 12 }, (_, index) => ({ code: 1000 + index })),
          ],
        },
        {
          status: 403,
          headers: {
            ratelimit: Array.from({ length: 5 }, (_, index) => `"default";r=${index};t=30`).join(
              ", ",
            ),
          },
        },
      );
    });
    await assert.rejects(operation(api), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /failed with HTTP 403/);
      assert.match(error.message, /"codes":\[1000,1001,1002,1003,1004,1005\]/);
      assert.match(error.message, /"ratelimit":"r=0;t=30, r=1;t=30, r=2;t=30, r=3;t=30"/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("each stage keeps vaults in its own namespace beside app sources", () => {
  assert.equal(vaultNamespace("basalt-production-apps"), "basalt-production-vaults");
  assert.equal(vaultNamespace("basalt-preview-pr-1419-apps"), "basalt-preview-pr-1419-vaults");
  assert.equal(vaultNamespace("sources"), "sources-vaults");
  assert.deepEqual(stageNamespaces("basalt-production-apps"), [
    "basalt-production-apps",
    "basalt-production-vaults",
  ]);
  assert.throws(() => vaultNamespace("Bad_Name"), /Invalid Artifacts vault namespace/);
});

test("the release admits a stage only when both namespaces already exist in the EU", async () => {
  const { admitSourceNamespace } = await import("./release-barrier/commands.ts");
  const props = {
    command: "node ensure-artifacts.ts",
    env: {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
      CLOUD_SOURCE_NAMESPACE: "basalt-production-apps",
    },
  };
  const provider = (...names: string[]) => {
    const state = fixture({
      namespaces: names.map((namespace) => ({ namespace, jurisdiction: "eu" })),
    });
    return { state, api: () => state.api };
  };
  const both = provider("basalt-production-apps", "basalt-production-vaults");
  await admitSourceNamespace(props, both.api);
  assert.deepEqual(both.state.calls, ["namespaces:", "namespaces:"]);
  // A missing vault namespace is an operator step, never something a release creates.
  const sourcesOnly = provider("basalt-production-apps");
  await assert.rejects(
    admitSourceNamespace(props, sourcesOnly.api),
    /source-namespace-provisioning-required/,
  );
  assert.ok(!sourcesOnly.state.calls.some((call) => call.startsWith("create:")));
});

const releaseProps = {
  command: "node ensure-artifacts.ts",
  env: {
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "deploy-token-fixture",
    CLOUD_SOURCE_NAMESPACE: "basalt-production-apps",
  },
};
/** The real HTTP client over a scripted provider, one response per list request. */
const scripted = (pages: Array<() => Response>) => {
  const urls: string[] = [];
  return {
    urls,
    api: (account: string, token: string) =>
      cloudflareArtifactsApi(account, token, async (input) => {
        urls.push(String(input));
        const next = pages.shift();
        if (!next) throw new Error("unexpected request");
        return next();
      }),
  };
};
const page = (result: unknown[], cursor?: string) => () =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: cursor ? { cursor } : {},
  });

test("a second namespace, extra fields and a paged listing still admit", async () => {
  const { admitSourceNamespace } = await import("./release-barrier/commands.ts");
  const both = [
    { namespace: "basalt-production-apps", jurisdiction: "eu", created_at: "2026-10-01T00:00:00Z" },
    { namespace: "basalt-production-vaults", jurisdiction: "eu", repos: 0 },
    { namespace: "basalt-scratch-deleting" },
  ];
  // Each namespace is read with its own full listing, here split over two pages.
  const provider = scripted([
    page(both.slice(0, 1), "c1"),
    page(both.slice(1)),
    page(both.slice(0, 2), "c2"),
    page(both.slice(2)),
  ]);
  await admitSourceNamespace(releaseProps, provider.api);
  assert.equal(provider.urls.length, 4);
  assert.ok(provider.urls[1]!.includes("cursor=c1"));
});

test("a refused namespace read names its class, HTTP status and provider codes", async () => {
  const { admitSourceNamespace } = await import("./release-barrier/commands.ts");
  const provider = scripted([
    () =>
      Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          result: null,
        },
        { status: 403 },
      ),
  ]);
  const refusal = await admitSourceNamespace(releaseProps, provider.api).then(
    () => assert.fail("expected a refusal"),
    (error: { reason: string; delta?: { why?: string[]; changed: unknown[] } }) => error,
  );
  assert.equal(refusal.reason, "source-namespace-not-ready");
  const detail = refusal.delta?.why?.join(" ") ?? "";
  assert.match(detail, /basalt-production-apps/);
  assert.match(detail, /HTTP 403/);
  assert.match(detail, /10000/);
  assert.doesNotMatch(JSON.stringify(refusal.delta), /deploy-token-fixture|Authentication error/);
});

test("a transport failure keeps only its class, never its host", async () => {
  const { admitSourceNamespace } = await import("./release-barrier/commands.ts");
  const provider = scripted([
    () => {
      throw new TypeError("fetch failed: connect ECONNRESET api.private.invalid:443");
    },
  ]);
  const refusal = await admitSourceNamespace(releaseProps, provider.api).then(
    () => assert.fail("expected a refusal"),
    (error: { reason: string; delta?: { why?: string[] } }) => error,
  );
  assert.equal(refusal.reason, "source-namespace-not-ready");
  assert.match(refusal.delta?.why?.join(" ") ?? "", /TypeError/);
  assert.doesNotMatch(JSON.stringify(refusal.delta), /private\.invalid|ECONNRESET/);
});

test("only the client's own failures keep detail, and only allow-listed diagnostic fields", async () => {
  const { readFailure } = await import("./release-barrier/commands.ts");
  // A transport error that imitates the client's suffix keeps nothing but its class.
  assert.equal(
    readFailure(
      new TypeError('fetch failed; diagnostics={"host":"private.invalid","token":"secret"}'),
    ),
    "TypeError",
  );
  const forged = readFailure(
    new Error(
      'Cloudflare Artifacts list failed with HTTP 403; diagnostics={"codes":[10000],"headers":{"cf-ray":"0123456789abcdef-ZRH","x-host":"private.invalid"},"token":"secret"}',
    ),
  );
  assert.match(forged, /HTTP 403/);
  assert.match(forged, /10000/);
  assert.match(forged, /0123456789abcdef-ZRH/);
  assert.doesNotMatch(forged, /private\.invalid|secret/);
  assert.equal(readFailure(new Error("unexpected provider text: private.invalid")), "Error");
});

test("pagination failures name themselves in the refusal", async () => {
  const { admitSourceNamespace } = await import("./release-barrier/commands.ts");
  const repeated = scripted([page([], "c1"), page([], "c1")]);
  const refusal = await admitSourceNamespace(releaseProps, repeated.api).then(
    () => assert.fail("expected a refusal"),
    (error: { delta?: { why?: string[] } }) => error,
  );
  assert.match(refusal.delta?.why?.join(" ") ?? "", /pagination repeated a cursor/);
  const { readFailure } = await import("./release-barrier/commands.ts");
  assert.match(
    readFailure(new Error("Cloudflare Artifacts pagination did not end")),
    /did not end/,
  );
});
