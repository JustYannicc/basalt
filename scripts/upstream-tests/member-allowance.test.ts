import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Clock, Effect, Exit, Fiber, Logger, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const { billingCatalogDeclaration, freeMembers } = await load(
  "apps/hosted/cloud/src/contracts/billing-catalog.ts",
);
const { memberAllowance } = await load("apps/hosted/cloud/src/implementation/member-allowance.ts");

const { catalog } = billingCatalogDeclaration("ci", "sandbox");
const customerId = `${catalog.namespace}:organization:org_fixture`;
const secret = "am_sk_test_fixture";

/**
 * Autumn's customer object in the wire shape API version 2.3.0 sends for `customers.get` and
 * `customers.get_or_create` (autumn-js 1.2.28's response schema): every required field, in
 * snake_case, with synthetic identifiers. It is a fixed answer, not an echo of the request.
 */
const autumnCustomer = (plan: string, quantity: number) => ({
  id: customerId,
  name: null,
  email: null,
  created_at: 1763380225417,
  fingerprint: null,
  stripe_id: "cus_fixture",
  env: "sandbox",
  metadata: {},
  send_email_receipts: false,
  billing_controls: {},
  subscriptions: [
    {
      id: "sub_fixture",
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
const missing = {
  status: 404,
  body: autumnError("customer_not_found", `Customer ${customerId} not found`),
};
/** An attempt Autumn never answers. */
const hang = "hang" as const;

type Reply = { readonly status: number; readonly body: unknown } | typeof hang;
type Log = { readonly level: string; readonly annotations: Record<string, unknown> };

/**
 * Check the allowance through the real Autumn adapter on virtual time: each route answers its
 * replies in order, and the clock advances 100 milliseconds at a time until the check settles.
 */
const check = async (replies: Record<string, ReadonlyArray<Reply>>) => {
  const requests: { route: string; customer: unknown }[] = [];
  const logs: Log[] = [];
  const http = HttpClient.make((request) =>
    Effect.suspend(() => {
      const route = new URL(request.url).pathname.split("/v1/")[1] ?? request.url;
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ route, customer: body?.customer_id });
      const reply = replies[route]?.[requests.filter((seen) => seen.route === route).length - 1];
      if (reply === hang) return Effect.never;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          reply === undefined
            ? Response.json(autumnError("unscripted", `No reply for ${route}`), { status: 500 })
            : Response.json(reply.body, { status: reply.status }),
        ),
      );
    }),
  );
  const capture = Logger.make((options) => {
    const { level, annotations } = Logger.formatStructured.log(options);
    logs.push({ level, annotations });
  });
  const options = {
    secretKey: Redacted.make(secret),
    serverUrl: Redacted.make("https://autumn.invalid/instance"),
  };
  const { exit, elapsed } = await Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const started = clock.currentTimeMillisUnsafe();
      const fiber = yield* memberAllowance(options, catalog, customerId).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.exit,
        Effect.forkChild,
      );
      while (fiber.pollUnsafe() === undefined && clock.currentTimeMillisUnsafe() - started < 30_000)
        yield* TestClock.adjust("100 millis");
      return {
        exit: (yield* Fiber.join(fiber)) as Exit.Exit<number, unknown>,
        elapsed: clock.currentTimeMillisUnsafe() - started,
      };
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([capture]))),
  );
  assert.ok(
    requests.every((request) => request.customer === customerId),
    "every call names the customer",
  );
  return { exit, elapsed, logs, routes: requests.map(({ route }) => route) };
};

const allowed = (exit: Exit.Exit<number, unknown>) => {
  assert.ok(
    Exit.isSuccess(exit),
    `the allowance check failed: ${Exit.isFailure(exit) ? Cause.pretty(exit.cause) : ""}`,
  );
  return exit.value;
};
const refused = (exit: Exit.Exit<number, unknown>) => {
  assert.ok(Exit.isFailure(exit), "the allowance check must fail closed");
  const error = Cause.squash(exit.cause) as Record<string, unknown>;
  assert.equal(error._tag, "MemberAllowanceUnavailable");
  return error;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("a transient Autumn failure then the existing customer admits the invitation, without a write", async () => {
  for (const transient of [
    unavailable,
    { status: 429, body: autumnError("rate_limit_exceeded", "Too many requests") },
    hang,
  ]) {
    const label = transient === hang ? "a hung read" : `${transient.status}`;
    const result = await check({
      "customers.get": [transient, { status: 200, body: autumnCustomer(catalog.team, 4) }],
      // Before the fix, this one write was the whole check.
      "customers.get_or_create": [
        unavailable,
        { status: 200, body: autumnCustomer(catalog.team, 4) },
      ],
    });
    assert.equal(allowed(result.exit), Number.POSITIVE_INFINITY, `after ${label}`);
    assert.deepEqual(result.routes, ["customers.get", "customers.get"], `after ${label}`);
    assert.ok(result.elapsed < 10_000, `answered within the budget after ${label}`);
  }
  const free = await check({
    "customers.get": [unavailable, { status: 200, body: autumnCustomer(catalog.free, 2) }],
  });
  assert.equal(allowed(free.exit), freeMembers);
});

test("persistent Autumn failure fails closed with its safe reason and the logged reference", async () => {
  const result = await check({ "customers.get": [unavailable, unavailable, unavailable] });
  const error = refused(result.exit);
  assert.deepEqual(
    { operation: error.operation, reason: error.reason, status: error.status },
    { operation: "getCustomer", reason: "status", status: 503 },
  );
  assert.match(String(error.reference), uuid);
  assert.deepEqual(result.routes, ["customers.get", "customers.get", "customers.get"]);
  const warnings = result.logs.filter(({ level }) => /warn/i.test(level));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.annotations.reference, error.reference);
  assert.equal(warnings[0]!.annotations.billingCustomer, customerId);
  assert.equal(
    JSON.stringify([error, result.logs]).includes(secret),
    false,
    "the key never leaves the adapter",
  );
});

test("Autumn that never answers fails closed with a timeout at the ten-second budget", async () => {
  const result = await check({ "customers.get": [hang, hang, hang] });
  const error = refused(result.exit);
  assert.equal(error.operation, "getCustomer");
  assert.equal(error.reason, "timeout");
  assert.ok(result.elapsed <= 10_000, `settled after ${result.elapsed} ms`);
  assert.deepEqual(result.routes, ["customers.get", "customers.get"]);
});

test("a definitive Autumn refusal or an unreadable customer is final", async () => {
  const denied = await check({
    "customers.get": [{ status: 401, body: autumnError("unauthorized", "Invalid secret key") }],
  });
  const refusal = refused(denied.exit);
  assert.deepEqual([refusal.reason, refusal.status], ["status", 401]);
  assert.deepEqual(denied.routes, ["customers.get"]);

  const unreadable = await check({
    "customers.get": [{ status: 200, body: { subscriptions: "active" } }],
  });
  assert.equal(refused(unreadable.exit).reason, "response");
  assert.deepEqual(unreadable.routes, ["customers.get"]);
});

test("only a customer Autumn has never seen is created, and creation is sent once", async () => {
  const created = await check({
    "customers.get": [missing],
    "customers.get_or_create": [{ status: 200, body: autumnCustomer(catalog.free, 1) }],
  });
  assert.equal(allowed(created.exit), freeMembers);
  assert.deepEqual(created.routes, ["customers.get", "customers.get_or_create"]);

  const uncertain = await check({
    "customers.get": [missing],
    "customers.get_or_create": [
      unavailable,
      { status: 200, body: autumnCustomer(catalog.free, 1) },
    ],
  });
  const error = refused(uncertain.exit);
  assert.deepEqual([error.operation, error.status], ["getOrCreateCustomer", 503]);
  assert.deepEqual(uncertain.routes, ["customers.get", "customers.get_or_create"]);
});
