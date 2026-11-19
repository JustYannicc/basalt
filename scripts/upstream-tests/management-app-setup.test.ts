import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { prepareManagementApp } from "../../.upstream/e2e/support/management-app.ts";
import { SessionClients, type Session } from "../../.upstream/e2e/support/api.ts";
import type { ManagementSetupRecord } from "../../.upstream/e2e/support/management-setup-diagnostics.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";

const base = Target.of({
  metadata: {
    target: "cloud",
    origin: "http://localhost:3000",
    mode: "managed",
    runtime: "fixture",
    commit: "fixture",
    dirty: false,
    startedAt: "2026-11-04T00:00:00Z",
    interactive: false,
    diagnostics: "fixture",
  },
  directory: ".local/fixture",
  apiKey: Redacted.make("fixture"),
  rows: 1,
  observeUI: false,
  recordingPaceMs: 0,
  fixtures: { origin: "http://127.0.0.1:1234", token: Redacted.make("fixture") },
});
const target = Target.of({ ...base, scenarioId: "scenario-owned" });

for (const settled of [false, true])
  test(`management setup dispatches before its ${settled ? "settled" : "linked"} readiness wait`, async () => {
    const requests: { method: string; path: string }[] = [];
    let dispatched = false;
    const actor: Session = {
      cookies: Effect.succeed(Redacted.make([])),
      send: () => Effect.die("unexpected direct actor request"),
    };
    const clients = SessionClients.of({
      session: () => Effect.succeed(actor),
      request: (_actor, method, path) =>
        Effect.sync(() => {
          requests.push({ method, path });
          if (method === "POST" && path === "/api/onboarding/prepare") {
            dispatched = true;
            return { status: 200, body: { status: "ready" } };
          }
          return {
            status: 200,
            body:
              path === "/api/auth/get-session"
                ? { user: { id: "user" } }
                : {
                    apps: [{ id: "app", slug: "executor", name: "Executor" }],
                    links: [{ app: "app", account: "account" }],
                    accounts: [],
                  },
          };
        }),
    });
    const fixtureCalls: string[] = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        assert.equal(dispatched, true, "readiness cannot finish before provisioning is dispatched");
        fixtureCalls.push(request.url);
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag === "Uint8Array")
          assert.deepEqual(JSON.parse(new TextDecoder().decode(request.body.body)), {
            id: "scenario-owned",
            user: "user",
            settled,
          });
        return HttpClientResponse.fromWeb(request, Response.json({ ready: true }));
      }),
    );
    const result = await Effect.runPromise(
      prepareManagementApp(actor, "organization", target, undefined, settled).pipe(
        Effect.provideService(Target, base),
        Effect.provideService(SessionClients, clients),
        Effect.provideService(HttpClient.HttpClient, http),
      ),
    );
    assert.equal(result.account, "account");
    assert.deepEqual(fixtureCalls, ["http://127.0.0.1:1234/management-provisioned"]);
    assert.deepEqual(requests, [
      { method: "POST", path: "/api/onboarding/prepare" },
      { method: "GET", path: "/api/auth/get-session" },
      { method: "GET", path: "/api/organizations/organization/inventory" },
    ]);
  });

const organization = "organization-7f3a";
const reads = [
  { operation: "prepare", method: "POST", path: "/api/onboarding/prepare" },
  { operation: "session", method: "GET", path: "/api/auth/get-session" },
  { operation: "inventory", method: "GET", path: `/api/organizations/${organization}/inventory` },
] as const;
const succeeded: Record<string, unknown> = {
  "/api/onboarding/prepare": { status: "ready" },
  "/api/auth/get-session": { user: { id: "user" } },
  [`/api/organizations/${organization}/inventory`]: {
    apps: [{ id: "app", slug: "executor", name: "Executor" }],
    links: [{ app: "app", account: "account" }],
    accounts: [],
  },
};

/** Run Cloud management setup through the real session client against one scripted product response. */
const setup = (failing: string, response: () => Response) => {
  const records: ManagementSetupRecord[] = [];
  const sent: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      if (url.origin === "http://127.0.0.1:1234")
        return HttpClientResponse.fromWeb(request, Response.json({ ready: true }));
      sent.push(`${request.method} ${url.pathname}`);
      return HttpClientResponse.fromWeb(
        request,
        url.pathname === failing ? response() : Response.json(succeeded[url.pathname]),
      );
    }),
  );
  const run = Effect.gen(function* () {
    const clients = yield* SessionClients;
    const actor = yield* clients.session();
    return yield* prepareManagementApp(actor, organization, target, (record) =>
      records.push(record),
    );
  }).pipe(
    Effect.flip,
    Effect.provide(SessionClients.layer),
    Effect.provideService(Target, base),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return Effect.runPromise(run).then((error) => ({ error, records, sent }));
};

const gatewayBodies = [
  { kind: "empty", response: () => new Response(null, { status: 502 }) },
  {
    kind: "HTML",
    response: () =>
      new Response("<html><body>Bad gateway</body></html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
  },
  { kind: "JSON", response: () => Response.json({ error: "Bad gateway" }, { status: 502 }) },
] as const;

for (const read of reads)
  for (const gateway of gatewayBodies)
    test(`setup ${read.method} ${read.operation} with a 502 ${gateway.kind} body names the request, not a decode`, async () => {
      const { error, records, sent } = await setup(read.path, gateway.response);
      assert.equal(
        (error as { _tag?: unknown })._tag,
        "SetupRequestFailed",
        `got ${String((error as { _tag?: unknown })._tag)}: ${String(error)}`,
      );
      const failed = error as unknown as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(failed)
          .filter((key) => key !== "_tag")
          .sort(),
        ["method", "operation", "status"],
      );
      assert.deepEqual(
        { operation: failed.operation, method: failed.method, status: failed.status },
        { operation: read.operation, method: read.method, status: 502 },
      );
      assert.equal(
        String((error as Error).message),
        `setup ${read.method} ${read.operation} → 502`,
      );
      for (const text of [String((error as Error).message), JSON.stringify(failed)]) {
        assert.doesNotMatch(text, new RegExp(organization));
        assert.doesNotMatch(text, /Bad gateway|html/i);
      }
      // No retry: setup stops at the first failed read.
      assert.equal(sent.at(-1), `${read.method} ${read.path}`);
      assert.equal(sent.filter((line) => line === `${read.method} ${read.path}`).length, 1);
      const record = records.at(-1);
      assert.equal(record?.step, read.operation);
      assert.equal(record?.outcome, "status");
    });

test("a successful setup read with the wrong shape is still a schema failure", async () => {
  const inventory = reads[2].path;
  const { error, records } = await setup(inventory, () => Response.json({ apps: "pending" }));
  assert.equal(Schema.isSchemaError(error), true, `got ${String(error)}`);
  assert.equal(records.at(-1)?.step, "inventory");
  assert.equal(records.at(-1)?.outcome, "schema");
  assert.equal(records.at(-1)?.response?.status, 200);
});
