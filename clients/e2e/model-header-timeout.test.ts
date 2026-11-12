import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { httpTimeoutClock } from "./http-timeout-fixture.ts";
import { deferred } from "./remote-fixture.ts";
import { fixtureHome } from "./support.ts";

for (const stream of [false, true]) {
  test(`model headers can arrive after thirty seconds, stream=${stream}`, async (t) => {
    const received = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    let profile: Awaited<ReturnType<typeof fixtureHome>> | undefined;
    let gateway: Awaited<ReturnType<NonNullable<typeof profile>["start"]>> | undefined;
    let request: Promise<Response> | undefined;
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) {
      }
      calls++;
      received.resolve();
      await release.promise;
      response.setHeader("content-type", stream ? "text/event-stream" : "application/json");
      response.end(stream ? "event: message_stop\ndata: {}\n\n" : '{"content":"synthetic"}');
    });
    t.after(async () => {
      release.resolve();
      await gateway?.stop();
      if (request) await Promise.allSettled([request]);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile?.remove();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const clock = await httpTimeoutClock(profile.home);
    gateway = await profile.start(clock.execArgv);
    const token = await profile.secret("models");
    request = fetch(`${gateway.origin}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic", stream }),
    });
    await received.promise;
    await clock.advance(45_000);
    release.resolve();
    const response = await request;
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, stream ? /message_stop/ : /synthetic/);
    assert.equal(calls, 1, "A slow reply must never dispatch another model request.");
  });
}

for (const capability of ["models", "tools"] as const) {
  test(`${capability} header deadline is bounded and never replays dispatch`, async (t) => {
    const received = deferred<void>();
    let calls = 0;
    const upstream = createServer(async (request) => {
      for await (const _chunk of request) {
      }
      calls++;
      received.resolve();
    });
    let profile: Awaited<ReturnType<typeof fixtureHome>> | undefined;
    let gateway: Awaited<ReturnType<NonNullable<typeof profile>["start"]>> | undefined;
    let request: Promise<Response> | undefined;
    t.after(async () => {
      await gateway?.stop();
      if (request) await Promise.allSettled([request]);
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await profile?.remove();
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
    const clock = await httpTimeoutClock(profile.home);
    gateway = await profile.start(clock.execArgv);
    const token = await profile.secret(capability);
    let answered = false;
    request = fetch(`${gateway.origin}${capability === "models" ? "/v1/messages" : "/mcp"}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "synthetic" }),
    }).then((response) => {
      answered = true;
      return response;
    });
    await received.promise;
    await clock.advance(capability === "models" ? 599_999 : 29_999);
    assert.equal(answered, false);
    await clock.advance(1);
    const response = await request;
    const body = await response.json();
    assert.equal(response.status, 502);
    if (capability === "models") {
      assert.equal(body.error.code, "upstream_outcome_unknown");
      assert.equal(body.error.retryable, false);
      assert.equal(response.headers.get("x-should-retry"), "false");
      assert.equal(response.headers.has("retry-after"), false);
    }
    assert.equal(calls, 1, "An unknown remote outcome cannot authorize another dispatch.");
  });
}

test("model response headers clear the wait timer before a long stream", async (t) => {
  const received = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {
    }
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("event: message_start\ndata: {}\n\n");
    received.resolve();
    await release.promise;
    response.end("event: message_stop\ndata: {}\n\n");
  });
  let profile: Awaited<ReturnType<typeof fixtureHome>> | undefined;
  let gateway: Awaited<ReturnType<NonNullable<typeof profile>["start"]>> | undefined;
  t.after(async () => {
    release.resolve();
    await gateway?.stop();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await profile?.remove();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  profile = await fixtureHome(`http://127.0.0.1:${address.port}`);
  const clock = await httpTimeoutClock(profile.home);
  gateway = await profile.start(clock.execArgv);
  const token = await profile.secret("models");
  const response = await fetch(`${gateway.origin}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "synthetic", stream: true }),
  });
  await received.promise;
  await clock.advance(600_000);
  release.resolve();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /message_stop/);
  assert.equal(calls, 1);
});
