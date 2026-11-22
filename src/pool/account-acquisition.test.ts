import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { homeReferences } from "./home-references.ts";
import { fixture, body, owner } from "./test/account-acquisition.ts";

test("a global sign-in retains exact project IDs across restart without attaching a pool", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  assert.equal(typeof started.session, "string");
  assert.deepEqual(await body(await f.send("start")), started);
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
  f.complete(["parent", "project-a", "project-b"]);
  const connected = await body(await f.send("status", { session: started.session }));
  assert.equal(connected.state, "connected");
  assert.equal(typeof connected.ref, "string");
  assert.deepEqual(homeReferences(String(connected.ref)), ["parent", "project-a", "project-b"]);
  assert.equal(f.markers.size, 0);
  assert.deepEqual([...f.excluded].sort(), ["parent", "project-a", "project-b"]);
  assert.equal(
    f.calls.some((call) => call.method === "POST" && call.path.includes("channel-group")),
    false,
  );
  f.restart();
  const before = f.calls.length;
  assert.deepEqual(await body(await f.send("status", { session: started.session })), connected);
  assert.equal(f.calls.length, before);
  assert.equal(
    (await f.send("status", { session: started.session }, "organization:another")).status,
    503,
  );
});

test("an unsigned request cannot warm Home or mutate acquisition state", async () => {
  const f = fixture();
  assert.equal((await f.unsigned()).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(f.markers.size, 0);
});

test("an uncertain start is retained and never repeated after eviction", async () => {
  const f = fixture();
  f.loseStart();
  assert.equal((await f.send("start")).status, 503);
  f.restart();
  assert.equal((await f.send("start")).status, 503);
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
  assert.equal(f.markers.size, 1);
});

test("a new connection cannot claim a credential that existed before sign-in", async () => {
  const f = fixture(["saved"]);
  const started = await body(await f.send("start"));
  f.complete(["saved"]);
  const failed = await body(await f.send("status", { session: started.session }));
  assert.equal(failed.state, "failed");
  await f.send("cancel", { session: started.session });
  assert.deepEqual([...f.credentials], ["saved"]);
  assert.equal(
    f.calls.some((call) => call.method === "DELETE" && call.path.includes("credentials")),
    false,
  );
});

test("failed-save cancellation retires only fresh credentials and preserves a reconnect", async () => {
  const f = fixture(["saved"]);
  const started = await body(await f.send("start", { reconnect: "saved" }));
  f.complete(["saved", "fresh"]);
  assert.equal(
    (await body(await f.send("status", { session: started.session }))).state,
    "connected",
  );
  assert.equal((await f.send("cancel", { session: started.session })).status, 200);
  assert.deepEqual([...f.credentials], ["saved"]);
  assert.equal(
    f.calls.filter((call) => call.method === "DELETE" && call.path.includes("credentials")).length,
    1,
  );
});

test("cancellation refuses to delete a credential already linked to a pool", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  f.complete(["fresh"]);
  await f.send("status", { session: started.session });
  f.members.add("fresh");
  assert.equal((await f.send("cancel", { session: started.session })).status, 503);
  assert.deepEqual([...f.credentials], ["fresh"]);
});

test("a status outage returns a closed receipt and keeps the same attempt recoverable", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  for (const [error, errorClass] of [
    [new Error("private credential must never escape"), "transport"],
    [new PoolRuntimeUnhealthy(), "runtime_unhealthy"],
    [new DOMException("private timeout detail", "TimeoutError"), "timeout"],
  ] as const) {
    f.failStatus(error);
    const unavailable = await f.send("status", { session: started.session });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "acquisition_unavailable",
      receipt: { phase: "oauth_status", errorClass, retryable: true },
    });
  }
  f.restart();
  f.failStatus();
  f.complete(["recovered"]);
  assert.equal(
    (await body(await f.send("status", { session: started.session }))).state,
    "connected",
  );
});

test("saved removal needs a host acting person and never borrows its organization owner", async () => {
  for (const actor of [undefined, "organization:fixture", "person"]) {
    const f = fixture(["saved"]);
    f.members.add("saved");
    const response = await f.send(
      "remove",
      { reference: "saved", ...(actor === undefined ? {} : { actor }) },
      owner,
      "remove-operation",
    );
    assert.equal(response.status, 200);
    assert.equal(f.credentials.has("saved"), false);
    assert.deepEqual(
      f.acknowledgements,
      actor === "person"
        ? [{ pool: "pool", references: ["saved"], actor: "person", operation: "remove-operation" }]
        : [],
    );
  }
});

test("native model discovery does not offer an OAuth sign-in for Jev keys", async () => {
  const f = fixture();
  assert.equal((await f.send("start", { provider: "typesafe" })).status, 503);
  assert.equal(f.calls.length, 0);
  assert.equal(f.markers.size, 0);
});

const signInRoute = { routeId: "rt_" + "a".repeat(26), owner: "org/fixture/user/example-user" };
function routeRecorder() {
  const events: string[] = [];
  const fleet = { oneImage: true };
  return {
    events,
    fleet,
    routes: {
      homogeneous: async () => fleet.oneImage,
      beginSignIn: async (session: string, route: { routeId: string }) => {
        events.push(`begin ${route.routeId}`);
      },
      settleSignIn: async (_session: string, references: readonly string[]) => {
        events.push(`settle ${references.join(",")}`);
      },
    },
  };
}

test("a routed owner's sign-in sends Home's code exchange through the route, and the saved credential keeps it", async () => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", {}, recorder.routes);
  const started = await body(await f.send("start", { hasRules: true, route: signInRoute }));
  const start = f.calls.find((call) => call.path.includes("/oauth/auth-url"))!;
  assert.equal(
    new URL(start.path, "https://fixture.invalid").searchParams.get("proxy_url"),
    `socks5://${signInRoute.routeId}:x@127.0.0.1:20990`,
  );
  // The owner check knows the route before Home can open the exchange's tunnel.
  assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`]);
  f.complete(["fresh"]);
  assert.equal(
    (await body(await f.send("status", { session: started.session }))).state,
    "connected",
  );
  assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`, "settle fresh"]);
});

test("a routed sign-in whose route is down fails as route_unavailable and is never retried directly", async () => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", {}, recorder.routes);
  const started = await body(await f.send("start", { hasRules: true, route: signInRoute }));
  f.statusIs({ status: "error", error: "proxy_unavailable" });
  assert.deepEqual(await body(await f.send("status", { session: started.session })), {
    state: "failed",
    message: "route_unavailable",
  });
  const starts = f.calls.filter((call) => call.path.includes("/oauth/auth-url"));
  assert.equal(starts.length, 1);
  assert.ok(starts.every((call) => call.path.includes("proxy_url=")));
  assert.ok(!f.calls.some((call) => call.path.includes("/oauth/callback")));
  assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`, "settle "]);
});

test("a sign-in its owner's rules route but no route applies to is refused with route_unavailable before Home sees it", async () => {
  for (const [routing, routes] of [
    [{ hasRules: true }, routeRecorder().routes],
    [{ hasRules: true, route: { routeId: "rt_../x", owner: "x" } }, routeRecorder().routes],
    // A controller without routing wired can't route anything.
    [{ hasRules: true, route: signInRoute }, undefined],
  ] as const) {
    const f = fixture([], "claude", {}, routes);
    const refused = await f.send("start", routing);
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: "route_unavailable" });
    assert.equal(f.calls.length, 0);
  }
});

test("a sign-in without route rules, or one the host decided is direct, starts exactly as on main", async () => {
  for (const routing of [{}, { hasRules: false }, { hasRules: true, route: null }]) {
    const recorder = routeRecorder();
    const f = fixture([], "claude", {}, recorder.routes);
    const started = await body(await f.send("start", routing));
    assert.equal(typeof started.session, "string");
    const starts = f.calls.filter((call) => call.path.includes("/oauth/auth-url"));
    assert.equal(starts.length, 1);
    assert.ok(!starts[0]!.path.includes("proxy_url"));
    assert.deepEqual(recorder.events, []);
  }
});

test("a routed start Home can't route is refused before any session: plugin providers and an unreachable route", async () => {
  for (const [provider, reply, expected] of [
    // A plugin provider's sign-in can't use a route (change 30).
    [
      "gemini-cli",
      () => Response.json({ error: "proxy_unsupported" }, { status: 400 }),
      "route_unsupported",
    ],
    // A device-flow start that can't reach its route.
    [
      "kimi",
      () => Response.json({ error: "proxy_unavailable" }, { status: 502 }),
      "route_unavailable",
    ],
  ] as const) {
    const recorder = routeRecorder();
    const f = fixture([], provider, {}, recorder.routes);
    f.startAnswers(reply);
    const refused = await f.send("start", { hasRules: true, route: signInRoute });
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), { error: expected });
    // One start, carrying the route; nothing else reaches Home's sign-in endpoints.
    const signIn = f.calls.filter((call) => call.path.includes("/oauth/"));
    assert.equal(signIn.length, 1);
    assert.ok(signIn[0]!.path.includes("proxy_url="));
    assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`, "settle "]);
  }
});

test("a proxy URL Home rejects is a pool bug: 500 with a reason code, no session", async () => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", {}, recorder.routes);
  f.startAnswers(() => Response.json({ error: "invalid_proxy_url" }, { status: 400 }));
  const failed = await f.send("start", { hasRules: true, route: signInRoute });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "internal" });
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/")).length, 1);
});

test("a teammate's sign-in in the same Home never takes another owner's route", async () => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", {}, recorder.routes);
  const owners = await body(await f.send("start", { hasRules: true, route: signInRoute }));
  assert.equal(typeof owners.session, "string");
  const mates = await body(
    await f.send("start", { hasRules: false }, "organization:teammate", "connect:mate"),
  );
  assert.equal(typeof mates.session, "string");
  const starts = f.calls.filter((call) => call.path.includes("/oauth/auth-url"));
  assert.equal(starts.length, 2);
  assert.ok(starts[0]!.path.includes("proxy_url="));
  assert.ok(!starts[1]!.path.includes("proxy_url"));
  // Only the owner's sign-in registered a route.
  assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`]);
});

test("a routed start with an uncertain answer still releases its route when the attempt expires", async (t) => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", {}, recorder.routes);
  f.startAnswers(() => new Response(null, { status: 503 }));
  assert.equal((await f.send("start", { hasRules: true, route: signInRoute })).status, 503);
  assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`]);
  const later = Date.now() + 2 * 24 * 60 * 60_000;
  t.mock.method(Date, "now", () => later);
  await f.tick();
  assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`, "settle "]);
});

test("a Home that can't route a sign-in session never gets a routed start: route_unsupported, nothing sent", async () => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", {}, recorder.routes);
  f.withoutSessionProxy();
  const refused = await f.send("start", { hasRules: true, route: signInRoute });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "route_unsupported" });
  assert.deepEqual(
    f.calls.map((call) => new URL(call.path, "https://fixture.invalid").pathname.split("/").pop()),
    ["capabilities"],
  );
  assert.deepEqual(recorder.events, []);
  // Someone without rules signs in as on main, on the same Home.
  assert.equal(
    typeof (await body(await f.send("start", { hasRules: false }, owner, "connect:plain"))).session,
    "string",
  );
});

test("a routed sign-in is refused while the serving runtimes run different images", async () => {
  const recorder = routeRecorder();
  recorder.fleet.oneImage = false;
  const f = fixture([], "claude", {}, recorder.routes);
  const refused = await f.send("start", { hasRules: true, route: signInRoute });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { error: "route_unsupported" });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(recorder.events, []);
});

test("a routed sign-in that loses a homogeneous fleet before its callback fails as route_unavailable and sends nothing more", async () => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", { flow: "callback" }, recorder.routes);
  const started = await body(await f.send("start", { hasRules: true, route: signInRoute }));
  assert.ok(started.paste);
  const before = f.calls.length;
  recorder.fleet.oneImage = false;
  assert.deepEqual(
    await body(
      await f.send("submit", {
        session: started.session,
        value: "http://localhost/cb?code=x&state=home-state",
      }),
    ),
    { state: "failed", message: "route_unavailable" },
  );
  assert.ok(!f.calls.slice(before).some((call) => call.path.includes("/oauth/")));
  assert.deepEqual(recorder.events, [`begin ${signInRoute.routeId}`, "settle "]);
});

test("a routed device sign-in that loses a homogeneous fleet stops polling: route_unavailable", async () => {
  const recorder = routeRecorder();
  const f = fixture([], "claude", {}, recorder.routes);
  const started = await body(await f.send("start", { hasRules: true, route: signInRoute }));
  const before = f.calls.length;
  recorder.fleet.oneImage = false;
  assert.deepEqual(await body(await f.send("status", { session: started.session })), {
    state: "failed",
    message: "route_unavailable",
  });
  assert.ok(!f.calls.slice(before).some((call) => call.path.includes("/oauth/")));
});

test("a routed sign-in that fails for any other reason keeps main's failure message", async () => {
  const failure = { status: "error", error: "Meta device sign-in failed" };
  const plain = fixture([], "meta");
  const plainStart = await body(await plain.send("start"));
  plain.statusIs(failure);
  const expected = await body(await plain.send("status", { session: plainStart.session }));
  const recorder = routeRecorder();
  const routed = fixture([], "meta", {}, recorder.routes);
  const routedStart = await body(
    await routed.send("start", { hasRules: true, route: signInRoute }),
  );
  routed.statusIs(failure);
  const answer = await body(await routed.send("status", { session: routedStart.session }));
  assert.equal(answer.state, "failed");
  assert.deepEqual(answer, expected);
  assert.notEqual(answer.message, "route_unavailable");
});
