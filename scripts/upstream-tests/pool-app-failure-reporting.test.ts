import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpServerRequest } from "effect/http";
import { PoolUsageUnavailable } from "../../.upstream/apps/hosted/server/src/contracts/pool-usage.ts";
import { load, refusalTag, reported, responseBody, routeTag } from "./pool-app-failure-fixture.ts";

const [summaryUi, poolUi, backend, usage, organizations, ui, sdk] = await Promise.all([
  load("apps/hosted/server/src/implementation/pool-summary-app-ui.ts"),
  load("apps/hosted/server/src/implementation/pool-app-ui.ts"),
  load("apps/hosted/server/src/implementation/pool-backend.ts"),
  load("apps/hosted/server/src/contracts/pool-usage.ts"),
  load("apps/hosted/server/src/contracts/organization.ts"),
  load("packages/apps/src/contracts/ui.ts"),
  load("packages/sdk/src/core.ts"),
]);
// Loaded by the tests that use it, so the other tests fail on their assertions without it.
const refusals = () => load("apps/hosted/server/src/implementation/pool-refusal.ts");

const version = sdk.VersionId.make("dpl_pool_app_failure");
const viewer = (userId = "viewer") => ({
  app: { id: sdk.AppId.make("app_pool_failure"), activeVersion: version },
  access: {
    organization: "org_pool_failure",
    owner: sdk.OwnerId.make("organization:org_pool_failure"),
    role: "admin" as const,
    userId,
  },
});

const bounds = { from: "2026-11-01T00:00:00Z", to: "2026-11-02T00:00:00Z" };
/** The page response, as the routes answer it. */
type Answer = {
  readonly status: number;
  readonly body: { readonly _tag: string; readonly body?: Uint8Array };
};
type Route = (authorize: Effect.Effect<ReturnType<typeof viewer>, object>) => Effect.Effect<Answer>;
const routes: Record<string, { readonly route: Route; readonly input: unknown }> = {
  "pool-usage/summary": { route: summaryUi.poolAppUsageSummary, input: bounds },
  "pool-usage/series": {
    route: poolUi.poolAppUsage,
    input: { ...bounds, bucket: "day", by: [] },
  },
  "pool-usage/overview": { route: poolUi.poolAppUsageOverview, input: { ...bounds, days: 7 } },
  "pool-usage/personal-overview": {
    route: poolUi.poolAppPersonalUsageOverview,
    input: { ...bounds, days: 7 },
  },
  "pool-usage/account-label": {
    route: poolUi.poolAppUsageAccountLabel,
    input: { account: `imported:${"a".repeat(64)}`, label: null },
  },
};
// A read that fails after authorization reaches the same catch-all as this failure does.
const failing = (route: string, error: object) => routes[route]!.route(Effect.fail(error));

const request = (body: unknown) =>
  HttpServerRequest.fromWeb(
    new Request("https://app.example.invalid/_executor/api/pool-usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const signed = {
  origin: "https://pool.example.invalid",
  key: Redacted.make("ab".repeat(32)),
};
/** A failed pool command, as its tag. */
type PoolError = { readonly _tag: string };
/** What the real pool command fails with when the pool answers `status` and `body`. */
const poolAnswer = (status: number, body: unknown, pool = "app_pool_failure") =>
  Effect.runPromise<PoolError, never>(
    backend
      .sendPoolCommand(
        "poolUsageSummary",
        { pool, organization: "org_pool_failure", user: "viewer", input: {} },
        Schema.Unknown,
      )
      .pipe(
        Effect.flip,
        Effect.provideService(usage.PoolUsageBackend, signed),
        Effect.provideService(FetchHttpClient.Fetch, async () => Response.json(body, { status })),
      ),
  );

const unavailable = { _tag: "UiFailed", reason: "unavailable" };
const unavailableText = "Pool usage could not be reached. Try again.";
const failureOf = (event: { exception?: { values?: readonly { type?: unknown }[] } }) =>
  event.exception?.values?.[0];

test("every mirrored pool refusal code is a code of the pool's contract", async () => {
  const contract = readFileSync(new URL("../../apps/pool/contract.ts", import.meta.url), "utf8");
  const union = /export type ControlErrorCode =([^;]+);/.exec(contract)?.[1];
  assert.ok(union, "apps/pool/contract.ts declares ControlErrorCode");
  const declared = new Set([...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]));
  const { poolRefusalCodes } = await refusals();
  assert.ok(poolRefusalCodes.length > 0);
  for (const code of poolRefusalCodes) assert.ok(declared.has(code), `${code} is a pool code`);
});

test("a pool refusal keeps its status and listed code, never its message or wire shape", async () => {
  const { poolRefusal } = await refusals();
  const secret = "private pool text for person@example.invalid";
  const tooLarge = await poolAnswer(503, { error: "history_too_large", message: secret }, "app_a");
  assert.equal(tooLarge._tag, "PoolUsageUnavailable");
  assert.deepEqual(poolRefusal(tooLarge), {
    status: 503,
    code: "history_too_large",
    pool: "app_a",
  });
  assert.ok(Schema.is(PoolUsageUnavailable)(tooLarge));
  const encode = Schema.encodeEffect(PoolUsageUnavailable);
  assert.deepEqual(
    await Effect.runPromise(encode(tooLarge)),
    await Effect.runPromise(encode(new PoolUsageUnavailable())),
  );
  // An unlisted code keeps only the status.
  assert.deepEqual(poolRefusal(await poolAnswer(503, { error: "busy", message: secret })), {
    status: 503,
    pool: "app_pool_failure",
  });
  assert.deepEqual(poolRefusal(await poolAnswer(404, { error: "not_found" })), {
    status: 404,
    code: "not_found",
    pool: "app_pool_failure",
  });
  // A failure the pool did not answer stays unnamed.
  const unreachable = await Effect.runPromise<PoolError, never>(
    backend.sendPoolCommand("poolUsageSummary", { pool: "app_a" }, Schema.Unknown).pipe(
      Effect.flip,
      Effect.provideService(usage.PoolUsageBackend, signed),
      Effect.provideService(FetchHttpClient.Fetch, async () => {
        throw new Error("connection refused");
      }),
    ),
  );
  assert.equal(unreachable._tag, "PoolUsageUnavailable");
  assert.equal(poolRefusal(unreachable), undefined);
});

test("each pool app route reports a 503 once, tagged with its route, by type and message", async () => {
  for (const route of Object.keys(routes)) {
    const { result, events } = await reported(failing(route, new usage.PoolUsageUnavailable()));
    assert.equal(result.status, 503, route);
    assert.deepEqual(responseBody(result), unavailable);
    assert.equal(events.length, 1, `${route} reports one event`);
    const [event] = events;
    assert.deepEqual(event!.exception, {
      values: [{ type: "PoolUsageUnavailable", value: unavailableText }],
    });
    assert.deepEqual(event!.tags, { [routeTag]: route });
    assert.deepEqual(event!.fingerprint, ["basalt", "PoolUsageUnavailable", route]);
    for (const key of ["extra", "request", "breadcrumbs"]) assert.equal(key in event!, false);
  }
  // Without the direct sink's projection the event still holds only the reduced failure.
  const { events } = await reported(
    failing("pool-usage/summary", new usage.PoolUsageUnavailable()),
    false,
  );
  assert.equal(events.length, 1);
  assert.equal(failureOf(events[0]!)?.type, "PoolUsageUnavailable");
  assert.equal(events[0]!.exception?.values?.[0]?.value, unavailableText);
  assert.equal(events[0]!.tags?.[routeTag], "pool-usage/summary");
});

test("nothing below 500 reports, though the page still reads a pool refusal as unavailable", async () => {
  const run = async (effect: Effect.Effect<Answer>, body: unknown = {}) => {
    const { result, events } = await reported(
      effect.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request(body))),
    );
    return { status: result.status, events: events.length };
  };
  for (const [name, { route, input }] of Object.entries(routes)) {
    assert.deepEqual(await run(route(Effect.succeed(viewer("")))), { status: 401, events: 0 });
    assert.deepEqual(await run(failing(name, new ui.UiForbidden())), { status: 403, events: 0 });
    assert.deepEqual(await run(failing(name, new organizations.OrganizationForbidden())), {
      status: 403,
      events: 0,
    });
    assert.deepEqual(await run(route(Effect.succeed(viewer()))), { status: 400, events: 0 });
    assert.deepEqual(
      await run(route(Effect.succeed(viewer())), { version: "dpl_other", input }),
      { status: 409, events: 0 },
      name,
    );
  }
  for (const [status, error] of [
    [400, "invalid_query"],
    [413, "invalid_query"],
    [401, "unauthorized"],
    [403, "unauthorized"],
    [404, "not_found"],
  ] as const) {
    const refused = await poolAnswer(status, { error, message: "private" });
    assert.deepEqual(await run(failing("pool-usage/summary", refused)), { status: 503, events: 0 });
  }
  // The same route still reports a pool failure at or above 500.
  const failed = await poolAnswer(503, { error: "backend_unavailable" });
  assert.deepEqual(await run(failing("pool-usage/summary", failed)), { status: 503, events: 1 });
});

test("a report never carries a token- or address-shaped message, nor an error's fields", async () => {
  const token = "sk_live_4f9a8b7c6d5e4f3a2b1c";
  const address = "person.name@example.invalid";
  const defect = new Error(`refresh for ${address} failed with ${token}\nat a private line`);
  for (const strictPrivacy of [true, false]) {
    const { result, events } = await reported(
      failing("pool-usage/overview", defect),
      strictPrivacy,
    );
    assert.equal(result.status, 503);
    assert.equal(events.length, 1);
    const text = JSON.stringify(events[0]);
    for (const secret of [token, address, "example.invalid", "private line"])
      assert.equal(text.includes(secret), false, `${secret} is not reported (${strictPrivacy})`);
    assert.equal(failureOf(events[0]!)?.type, "Error");
    assert.match(String(events[0]!.exception?.values?.[0]?.value), /^refresh for <email> failed/);
  }
  // A tagged error is recorded by its tag and declared sentence, never its message or fields.
  class PrivateFailure extends Error {
    readonly _tag = "PrivateFailure";
    readonly detail = token;
    constructor() {
      super(`lookup for ${address} refused`);
    }
  }
  const { events } = await reported(failing("pool-usage/series", new PrivateFailure()));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.exception, { values: [{ type: "PrivateFailure" }] });
  assert.equal(JSON.stringify(events[0]).includes(token), false);
  assert.equal(JSON.stringify(events[0]).includes(address), false);
  const storage = await reported(failing("pool-usage/series", new sdk.StorageError()));
  assert.deepEqual(storage.events[0]!.exception, {
    values: [{ type: "StorageError", value: "Could not read or write saved data." }],
  });
});

test("pool failures report on every occurrence; a repeated named refusal once per cause", async () => {
  const { refusedBy } = await refusals();
  const count = async (route: string, error: () => object | Promise<object>, times = 2) => {
    const events = [];
    for (let attempt = 0; attempt < times; attempt++)
      events.push(...(await reported(failing(route, await error()))).events);
    return events;
  };
  const unavailableEvents = await count("pool-usage/summary", () =>
    poolAnswer(503, { error: "backend_unavailable" }),
  );
  assert.equal(unavailableEvents.length, 2);
  for (const event of unavailableEvents)
    assert.deepEqual(event.tags, {
      [routeTag]: "pool-usage/summary",
      [refusalTag]: "backend_unavailable",
    });
  const timeout = () =>
    refusedBy(
      new usage.PoolUsageTimedOut(),
      { status: 504, body: { error: "history_timeout", message: "private" } },
      { pool: "app_pool_failure" },
    );
  const timeouts = await count("pool-usage/series", timeout);
  assert.equal(timeouts.length, 2);
  assert.equal(failureOf(timeouts[0]!)?.type, "PoolUsageTimedOut");
  assert.equal(timeouts[0]!.tags?.[refusalTag], "history_timeout");
  assert.equal((await count("pool-usage/overview", () => new sdk.StorageError())).length, 2);

  const tooLarge = (pool: string) => () =>
    poolAnswer(503, { error: "history_too_large", message: "private" }, pool);
  const first = await count("pool-usage/summary", tooLarge("app_too_large_a"), 3);
  assert.equal(first.length, 1, "one pool's repeated refusal reports once");
  assert.deepEqual(first[0]!.tags, {
    [routeTag]: "pool-usage/summary",
    [refusalTag]: "history_too_large",
  });
  assert.equal((await count("pool-usage/summary", tooLarge("app_too_large_b"))).length, 1);
  // The held-back cause hides no other failure of the same pool.
  const other = await count("pool-usage/summary", () =>
    poolAnswer(503, { error: "backend_unavailable" }, "app_too_large_a"),
  );
  assert.equal(other.length, 2);
});
