import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { prepareManagementApp } from "../../.upstream/e2e/support/management-app.ts";
import { SessionClients, type Session } from "../../.upstream/e2e/support/api.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";

test("management setup uses its scenario target when the ambient target has no scenario id and dispatches before waiting", async () => {
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
        });
      return HttpClientResponse.fromWeb(request, Response.json({ ready: true }));
    }),
  );
  const result = await Effect.runPromise(
    prepareManagementApp(actor, "organization", target).pipe(
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
