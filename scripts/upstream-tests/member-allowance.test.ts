import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const { AutumnClient } = await load("apps/hosted/cloud/src/contracts/autumn.ts");
const { billingCatalogDeclaration, freeMembers } = await load(
  "apps/hosted/cloud/src/contracts/billing-catalog.ts",
);
const { autumnLive, autumnReads } = await load(
  "apps/hosted/cloud/src/implementation/autumn-client.ts",
);
const { memberAllowance } = await load("apps/hosted/cloud/src/implementation/member-allowance.ts");

const { catalog } = billingCatalogDeclaration("ci", "sandbox");
const customerId = `${catalog.namespace}:organization:org_01KA7Y0F4N3V5J8RX2C6M9QH1T`;

/**
 * Autumn's customer object as API version 2.3.0 sends it (the autumn-js 1.2.28 wire schema for
 * `customers.get` and `customers.get_or_create`): every required field, snake_case, not an echo
 * of the request.
 */
const recordedCustomer = (plan: string, quantity: number) => ({
  id: customerId,
  name: null,
  email: null,
  created_at: 1763380225417,
  fingerprint: null,
  stripe_id: "cus_TQh2mV8xK4pLrN",
  env: "sandbox",
  metadata: {},
  send_email_receipts: false,
  billing_controls: {},
  subscriptions: [
    {
      id: "sub_01KA7Y1B6WQ0S3D9EJ5T2R8N4M",
      plan_id: plan,
      auto_enable: plan === catalog.free,
      add_on: false,
      status: "active",
      past_due: false,
      canceled_at: null,
      expires_at: null,
      trial_ends_at: null,
      started_at: 1763380225417,
      current_period_start: plan === catalog.free ? null : 1763380225417,
      current_period_end: plan === catalog.free ? null : 1766058625417,
      quantity,
    },
  ],
  purchases: [],
  balances: {
    [catalog.members]: {
      feature_id: catalog.members,
      granted: plan === catalog.free ? freeMembers : 0,
      remaining: plan === catalog.free ? freeMembers - quantity : 0,
      usage: quantity,
      unlimited: false,
      overage_allowed: plan !== catalog.free,
      max_purchase: null,
      next_reset_at: null,
    },
  },
  flags: {},
});
/** Autumn's error body; only a 404 with `customer_not_found` is an answer. */
const autumnError = (code: string, message: string) => ({ message, code, env: "sandbox" });
const unavailable = { status: 503, body: autumnError("internal_error", "Internal server error") };

type Reply = { readonly status: number; readonly body: unknown };

/** Autumn reached through the real adapter: each route answers its replies in order. */
const scripted = (replies: Record<string, ReadonlyArray<Reply>>) => {
  const requests: { route: string; customer: unknown }[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const route = new URL(request.url).pathname.split("/v1/")[1] ?? request.url;
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ route, customer: body?.customer_id });
      const reply = replies[route]?.[requests.filter((seen) => seen.route === route).length - 1];
      return HttpClientResponse.fromWeb(
        request,
        reply === undefined
          ? Response.json(autumnError("unscripted", `No reply for ${route}`), { status: 500 })
          : Response.json(reply.body, { status: reply.status }),
      );
    }),
  );
  const allowance = Effect.gen(function* () {
    const autumn = yield* AutumnClient.pipe(
      Effect.provide(
        autumnLive(
          {
            secretKey: Redacted.make("am_sk_test_fixture"),
            serverUrl: Redacted.make("https://autumn.invalid/instance"),
          },
          autumnReads.allowance,
        ),
      ),
      Effect.provideService(HttpClient.HttpClient, http),
    );
    return yield* memberAllowance(autumn, catalog, customerId);
  });
  return { requests, run: () => Effect.runPromiseExit(allowance) };
};

const allowed = (exit: Exit.Exit<number, unknown>) => {
  assert.ok(Exit.isSuccess(exit), `the allowance check failed: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`);
  return exit.value;
};
const failure = (exit: Exit.Exit<number, unknown>) => {
  assert.ok(Exit.isFailure(exit), "the allowance check must fail closed");
  return Cause.squash(exit.cause) as Record<string, unknown>;
};
const routes = (requests: ReadonlyArray<{ route: string }>) =>
  requests.map(({ route }) => route);

test("a transient Autumn failure then the recorded customer admits the invitation, without a write", async () => {
  for (const transient of [unavailable, { status: 429, body: autumnError("rate_limit", "") }]) {
    const autumn = scripted({
      "customers.get": [transient, { status: 200, body: recordedCustomer(catalog.team, 4) }],
    });
    assert.equal(allowed(await autumn.run()), Number.POSITIVE_INFINITY, `after ${transient.status}`);
    assert.deepEqual(routes(autumn.requests), ["customers.get", "customers.get"]);
    assert.ok(autumn.requests.every((request) => request.customer === customerId));
  }
  const free = scripted({
    "customers.get": [unavailable, { status: 200, body: recordedCustomer(catalog.free, 2) }],
  });
  assert.equal(allowed(await free.run()), freeMembers);
});

test("persistent Autumn failure fails closed with its safe reason and a reference", async () => {
  const autumn = scripted({ "customers.get": [unavailable, unavailable, unavailable] });
  const error = failure(await autumn.run());
  assert.equal(error._tag, "MemberAllowanceUnavailable");
  assert.equal(error.operation, "getCustomer");
  assert.equal(error.reason, "status");
  assert.equal(error.status, 503);
  assert.match(String(error.reference), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(JSON.stringify(error).includes("am_sk_test_fixture"), false);
  assert.deepEqual(routes(autumn.requests), ["customers.get", "customers.get", "customers.get"]);
});

test("an unreadable customer body is final and fails closed", async () => {
  const autumn = scripted({ "customers.get": [{ status: 200, body: { subscriptions: "active" } }] });
  const error = failure(await autumn.run());
  assert.equal(error._tag, "MemberAllowanceUnavailable");
  assert.equal(error.reason, "response");
  assert.deepEqual(routes(autumn.requests), ["customers.get"]);
});

test("only a customer Autumn has never seen is created, and creation is sent once", async () => {
  const missing = {
    status: 404,
    body: autumnError("customer_not_found", `Customer ${customerId} not found`),
  };
  const created = scripted({
    "customers.get": [missing],
    "customers.get_or_create": [{ status: 200, body: recordedCustomer(catalog.free, 1) }],
  });
  assert.equal(allowed(await created.run()), freeMembers);
  assert.deepEqual(routes(created.requests), ["customers.get", "customers.get_or_create"]);

  const uncertain = scripted({
    "customers.get": [missing],
    "customers.get_or_create": [unavailable, { status: 200, body: recordedCustomer(catalog.free, 1) }],
  });
  const error = failure(await uncertain.run());
  assert.equal(error._tag, "MemberAllowanceUnavailable");
  assert.equal(error.operation, "getOrCreateCustomer");
  assert.equal(error.status, 503);
  assert.deepEqual(routes(uncertain.requests), ["customers.get", "customers.get_or_create"]);
});
