import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { makeReadOnlyHttpStateStore } from "alchemy/State/ReadOnlyHttpStateStore";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import { encodeState } from "alchemy/State/StateEncoding";
import {
  stateApiFixture,
  fullToken,
  readerToken,
  scope,
  scopePath,
} from "./state-readonly-fixture.ts";

const value: CreatedResourceState = {
  status: "created",
  resourceType: "Fixture.Worker",
  namespace: undefined,
  fqn: "outer/Worker",
  logicalId: "Worker",
  instanceId: "fixture-instance",
  providerVersion: 1,
  downstream: [],
  bindings: [],
  props: { key: Redacted.make("fixture-private-value"), date: new Date("2026-01-01T00:00:00Z") },
  attr: { id: "fixture-worker" },
};
const resourcePath = `${scopePath}/resources/${encodeURIComponent(encodeURIComponent(value.fqn))}`;
const clientOptions = {
  url: "https://state.example.test",
  authToken: Redacted.make(readerToken),
  ...scope,
  expectedVersion: 8,
};

test("the public state API provisions, scopes and revokes a separate reader without changing deployment access", async (context) => {
  const fixture = await stateApiFixture();
  context.after(fixture.dispose);
  assert.equal((await fixture.request("GET", `${scopePath}/resources`, readerToken)).status, 401);
  assert.equal((await fixture.provision()).status, 200);
  assert.equal(
    (await fixture.request("PUT", resourcePath, fullToken, encodeState(value))).status,
    200,
  );
  assert.equal((await fixture.request("GET", resourcePath, readerToken)).status, 200);
  assert.equal((await fixture.request("GET", `${scopePath}/resources`, readerToken)).status, 200);
  assert.equal((await fixture.request("GET", `${scopePath}/output`, readerToken)).status, 200);
  assert.equal(
    (await fixture.request("GET", `${scopePath}/replaced-resources`, readerToken)).status,
    200,
  );
  const before = [...fixture.writes];
  for (const [method, path, payload] of [
    ["PUT", resourcePath, encodeState(value)],
    ["DELETE", resourcePath, undefined],
    ["PUT", `${scopePath}/output`, { private: "forbidden" }],
    ["DELETE", "/state/stacks/fixture", undefined],
    ["DELETE", "/state/stacks/fixture?stage=production", undefined],
    ["GET", "/state/stacks", undefined],
    ["GET", "/state/stacks/fixture/stages", undefined],
    ["GET", "/state/stacks/other/stages/production/resources", undefined],
    ["GET", "/state/stacks/fixture/stages/other/resources", undefined],
    ["GET", `${fixture.grantPath}/output`, undefined],
    ["GET", `${scopePath}/resources?stage=other`, undefined],
    ["HEAD", `${scopePath}/resources`, undefined],
  ] as const) {
    assert.equal(
      (await fixture.request(method, path, readerToken, payload)).status,
      401,
      `${method} ${path}`,
    );
  }
  assert.deepEqual(fixture.writes, before);
  assert.equal((await fixture.revoke()).status, 204);
  assert.equal((await fixture.request("GET", resourcePath, readerToken)).status, 401);
  assert.equal((await fixture.request("GET", resourcePath, fullToken)).status, 200);
  assert.equal((await fixture.request("DELETE", resourcePath, fullToken)).status, 204);
});

test("malformed, wildcard and surplus-field grants never authorize the public API", async (context) => {
  const fixture = await stateApiFixture();
  context.after(fixture.dispose);
  for (const grant of [
    { version: 1, access: "read-write", ...scope },
    { version: 1, access: "read-only", stack: "*", stage: "*" },
    { version: 1, access: "read-only", ...scope, extra: true },
    { version: 2, access: "read-only", ...scope },
    { version: 1, access: "read-only", stack: "fixture", stage: ".." },
    {
      version: 1,
      access: "read-only",
      stack: "__alchemy_state_readers__",
      stage: fixture.readerId,
    },
  ]) {
    assert.equal(
      (await fixture.request("PUT", `${fixture.grantPath}/output`, fullToken, grant)).status,
      200,
    );
    assert.equal((await fixture.request("GET", `${scopePath}/resources`, readerToken)).status, 401);
  }
});

function clientTransport(fixture: Awaited<ReturnType<typeof stateApiFixture>>) {
  const requests: Array<{ method: string; url: string; redirect: RequestRedirect | undefined }> =
    [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ method: request.method, url: request.url, redirect: init?.redirect });
    return fixture.handler(request);
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  return { requests, run };
}

test("the direct client reads the wire format with GET only and refuses every mutation before transport", async (context) => {
  const fixture = await stateApiFixture();
  context.after(fixture.dispose);
  await fixture.provision();
  await fixture.request("PUT", resourcePath, fullToken, encodeState(value));
  const transport = clientTransport(fixture);
  const client = await transport.run(makeReadOnlyHttpStateStore(clientOptions));
  assert.deepEqual(await transport.run(client.listStacks()), [scope.stack]);
  assert.deepEqual(await transport.run(client.listStages(scope.stack)), [scope.stage]);
  assert.deepEqual(await transport.run(client.list(scope)), [value.fqn]);
  const found = await transport.run(client.get({ ...scope, fqn: value.fqn }));
  assert.ok(found);
  assert.equal(found.status, "created");
  if (found.status !== "created") assert.fail("Expected created resource");
  assert.deepEqual(found.attr, value.attr);
  assert.equal(Redacted.value(found.props?.key), "fixture-private-value");
  assert.deepEqual(found.props?.date, value.props.date);
  await transport.run(client.getReplacedResources(scope));
  await transport.run(client.getOutput(scope));
  const before = transport.requests.length;
  for (const effect of [
    client.set({ ...scope, fqn: value.fqn, value }),
    client.delete({ ...scope, fqn: value.fqn }),
    client.deleteStack(scope),
    client.setOutput({ ...scope, value: "forbidden" }),
    client.get({ ...scope, stage: "other", fqn: value.fqn }),
    client.getOutput({ ...scope, stack: "other" }),
    client.getReplacedResources({ ...scope, stage: "other" }),
    client.list({ ...scope, stack: "other" }),
    client.listStages("other"),
  ])
    await assert.rejects(transport.run(effect), /Read-only state request refused/);
  assert.equal(transport.requests.length, before);
  assert.ok(transport.requests.length >= 6);
  assert.ok(
    transport.requests.every((request) => request.method === "GET" && request.redirect === "error"),
  );
  await fixture.revoke();
  await assert.rejects(
    transport.run(client.get({ ...scope, fqn: value.fqn })),
    /Read-only state request failed/,
  );
});

test("stale versions and invalid origins fail without bootstrap, credential refresh or a second destination", async (context) => {
  const fixture = await stateApiFixture();
  context.after(fixture.dispose);
  await fixture.provision();
  const transport = clientTransport(fixture);
  fixture.setVersion(7);
  await assert.rejects(transport.run(makeReadOnlyHttpStateStore(clientOptions)), /version differs/);
  assert.equal(transport.requests.length, 1);
  assert.ok(transport.requests[0]?.url.endsWith("/version"));
  for (const url of [
    "http://state.example.test",
    "https://state.example.test/other",
    "https://user:secret@state.example.test",
    "https://state.example.test?secret=value",
  ])
    await assert.rejects(
      transport.run(makeReadOnlyHttpStateStore({ ...clientOptions, url })),
      /refused/,
    );
  assert.equal(transport.requests.length, 1);
});

test("redirects fail without following them and failure diagnostics retain no response body or credential", async () => {
  const destinations: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(init?.redirect, "error");
    destinations.push(request.url);
    return new Response("fixture-sensitive-response-body", {
      status: 302,
      headers: { location: "https://another.example.test/private" },
    });
  };
  try {
    await Effect.runPromise(
      makeReadOnlyHttpStateStore(clientOptions).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
    assert.fail("redirect accepted");
  } catch (error) {
    const serialized = String(error);
    assert.match(serialized, /Read-only state request failed/);
    for (const privateValue of [
      readerToken,
      "fixture-sensitive-response-body",
      "another.example.test",
    ])
      assert.ok(!serialized.includes(privateValue));
  }
  assert.equal(destinations.length, 1);
});
