import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { prepareManagementApp } from "../../.upstream/e2e/support/management-app.ts";
import { SessionClients, type Session } from "../../.upstream/e2e/support/api.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";

test("management setup uses its scenario target when the ambient target has no scenario id", async () => {
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
  const requests: string[] = [];
  const actor: Session = {
    cookies: Effect.succeed(Redacted.make([])),
    send: () => Effect.die("unexpected direct actor request"),
  };
  const clients = SessionClients.of({
    session: () => Effect.succeed(actor),
    request: (_actor, _method, path) =>
      Effect.sync(() => {
        requests.push(path);
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
    "/api/auth/get-session",
    "/api/organizations/organization/inventory",
  ]);
});
