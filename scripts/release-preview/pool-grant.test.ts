import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, owner, pool, signingKey } from "../../src/pool/test/computers.ts";
import { nativeControlPath, nativeModelHeader } from "../../src/pool/native-contract.ts";
import { openPreviewPoolGrant } from "./pool-grant.ts";
import { previewPlanQuotaAvailable } from "./pool-grant-quota.ts";

function quota(now: number) {
  const observedAt = new Date(now - 100).toISOString();
  const staleAt = new Date(now + 60_000).toISOString();
  return {
    isOwner: true,
    reading: { source: "live", revalidationFailed: false, readAt: { quota: observedAt } },
    accounts: [
      {
        id: "claude-plan",
        provider: "claude",
        state: "active",
        plan: "Max",
        readingFailed: false,
        freshness: "fresh",
        observedAt,
        staleAt,
        windows: ["claude-five-hour", "claude-seven-day"].map((id) => ({
          id,
          remainingRatio: 0.5,
          observedAt,
          resetAt: staleAt,
        })),
        usageCredits: { freshness: "fresh", observedAt, staleAt, extraUsage: { enabled: false } },
        usageRouting: { use: "plan", eligible: true },
      },
    ],
  };
}

function harness() {
  const f = fixture();
  f.advance(Date.now() - f.now());
  let view = quota(f.now());
  let inferences = 0;
  let lostReply = false;
  const paths: string[] = [];
  const transport: typeof fetch = async (input) => {
    const request = new Request(input);
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === "/pool/v1/pool") return Response.json(view);
    if (path === "/pool/v1/setup-context") return f.context(owner);
    if (path === nativeControlPath) {
      const response = await f.nativeControl(request);
      if (lostReply) {
        lostReply = false;
        throw new Error("private transport output");
      }
      return response;
    }
    if (path === "/v1/messages") {
      try {
        const lease = await f.nativeModel(request);
        assert.equal(lease.request.headers.has(nativeModelHeader), false);
        assert.equal(lease.pool, pool.pool);
        lease.release();
        inferences++;
        return new Response("event: message_stop\ndata: {}\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      } catch {
        return new Response(null, { status: 401 });
      }
    }
    throw new Error("Unexpected fixture request");
  };
  return {
    f,
    paths,
    config: {
      origin: "https://pool.example",
      poolId: pool.pool,
      ownerId: owner,
      organizationId: pool.organization,
      signingKey,
    },
    options: { fetch: transport, now: f.now },
    view: () => view,
    changeView: (next: typeof view) => {
      view = next;
    },
    inferences: () => inferences,
    loseRegistrationReply: () => {
      lostReply = true;
    },
  };
}

const request = (
  modelUrl: string,
  modelKey: string,
  model = "claude-opus-5-5",
  path = "/v1/messages",
) =>
  fetch(modelUrl + path, {
    method: "POST",
    headers: { "x-api-key": modelKey, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 8,
      messages: [{ role: "user", content: "fixture" }],
    }),
  });

test("native model-only grant forwards the pinned stream and revokes its exact server key", async () => {
  const h = harness();
  const grant = await openPreviewPoolGrant(h.config, h.options);
  const registry = Object.values(await h.f.registry());
  assert.equal(registry.length, 1);
  assert.equal(registry[0]?.native?.models, true);
  assert.equal(registry[0]?.native?.toolsOrganization, undefined);
  assert.equal(registry[0]?.toolsKeyId, undefined);
  assert.equal(JSON.stringify(grant).includes(String(h.f.server.keys[0]?.api_key)), false);
  const response = await request(grant.modelUrl, grant.modelKey);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "event: message_stop\ndata: {}\n\n");
  assert.equal(h.inferences(), 1);
  assert.deepEqual(grant.evidence(), {
    model: "claude-opus-5-5",
    requests: 1,
    planQuotaChecked: true,
    extraUsageDisabled: true,
  });
  assert.deepEqual(await grant.close(), { revoked: true, unauthorized: true });
  assert.deepEqual(await grant.close(), { revoked: true, unauthorized: true });
  assert.equal(h.inferences(), 1, "revoked probe must fail before inference");
  assert.equal(h.f.server.keys.length, 0);
  assert.equal(Object.values(await h.f.registry())[0]?.state, "revoked");
  assert.equal(
    h.paths.some((path) => path.startsWith("/__setup/")),
    false,
  );
});

test("local proxy refuses other models, paths and credentials before dispatch", async () => {
  const h = harness();
  const grant = await openPreviewPoolGrant(h.config, h.options);
  try {
    for (const [key, model, path, status] of [
      [grant.modelKey, "gpt-6.1-sol", "/v1/messages", 400],
      [grant.modelKey, "claude-opus-5-5", "/v1/responses", 404],
      ["wrong-nonce", "claude-opus-5-5", "/v1/messages", 401],
    ] as const) {
      const response = await request(grant.modelUrl, key, model, path);
      assert.equal(response.status, status);
      await response.body?.cancel();
    }
    assert.equal(h.inferences(), 0);
    assert.equal(grant.evidence().requests, 0);
  } finally {
    await grant.close();
  }
});

test("fresh quota and disabled extra usage are required before every dispatch", async () => {
  const h = harness();
  const grant = await openPreviewPoolGrant(h.config, h.options);
  h.view().accounts[0]!.usageCredits.extraUsage.enabled = true;
  const response = await request(grant.modelUrl, grant.modelKey);
  assert.equal(response.status, 502);
  assert.equal(h.inferences(), 0);
  await grant.close();
});

test("uncertain registration is inspected and cleaned without repeating the mutation", async () => {
  const h = harness();
  h.loseRegistrationReply();
  await assert.rejects(openPreviewPoolGrant(h.config, h.options), /failed: transport/);
  const rows = Object.values(await h.f.registry());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.state, "revoked");
  assert.equal(h.f.server.keys.length, 0);
  assert.equal(h.inferences(), 0);
  assert.equal(h.paths.filter((path) => path === nativeControlPath).length, 2);
});

test("a failed revoke never produces a successful close result", async () => {
  const h = harness();
  const grant = await openPreviewPoolGrant(h.config, h.options);
  h.f.server.revokeFailure = true;
  await assert.rejects(grant.close(), /failed: revoke/);
  assert.equal(Object.values(await h.f.registry())[0]?.state, "revoking");
  h.f.server.revokeFailure = false;
  // The fixture has no remote resources; exercise the failed row's normal cleanup directly.
  const row = Object.values(await h.f.registry())[0]!;
  assert.ok(row.native);
  const { signEnvelope, hostAssertionTtlMs } = await import("../../src/pool/token.ts");
  const envelope = await signEnvelope(signingKey, "sbn1", {
    action: "revoke",
    user: owner,
    grant: row.native.grant,
    computer: row.id,
    pool: pool.pool,
    expiresAt: h.f.now() + hostAssertionTtlMs,
  });
  assert.equal(
    (
      await h.f.nativeControl(
        new Request("https://pool.example/native/v1/control", {
          method: "POST",
          body: JSON.stringify({ envelope }),
        }),
      )
    ).status,
    200,
  );
});

test("quota guard refuses stale, missing, credits-only and unsafe account facts", () => {
  const now = Date.now();
  assert.equal(previewPlanQuotaAvailable(quota(now), now), true);
  const cases: Array<(value: ReturnType<typeof quota>) => void> = [
    (value) => {
      value.reading.source = "snapshot";
    },
    (value) => {
      value.reading.revalidationFailed = true;
    },
    (value) => {
      value.accounts[0]!.provider = "codex";
    },
    (value) => {
      value.accounts[0]!.freshness = "stale";
    },
    (value) => {
      value.accounts[0]!.windows = [];
    },
    (value) => {
      value.accounts[0]!.windows[0]!.remainingRatio = 0;
    },
    (value) => {
      value.accounts[0]!.usageCredits.extraUsage.enabled = true;
    },
    (value) => {
      value.accounts[0]!.usageRouting.use = "credits";
    },
  ];
  for (const mutate of cases) {
    const value = quota(now);
    mutate(value);
    assert.equal(previewPlanQuotaAvailable(value, now), false);
  }
  assert.equal(previewPlanQuotaAvailable({ accounts: [] }, now), false);
});
