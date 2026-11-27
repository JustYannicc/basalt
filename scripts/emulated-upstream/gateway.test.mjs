// The stage Worker's key gate, its two account profiles and profile b's control, run against a
// stand-in for aimock behind the container's port.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chaosFrom,
  forward,
  gate,
  mockCalls,
  profileControlPath,
  profileRoute,
  RETRY_AFTER_SECONDS,
} from "./gateway.ts";
import { refusalPath } from "./mock-start.ts";
import { paths, requestBody, verdict } from "./shapes.mjs";
import { chaos429Body } from "./test/aimock-shapes.mjs";
import { fakeAimock, memoryStore } from "./test/fake-aimock.mjs";

const key = "k".repeat(43);
const origin = "https://basalt-emulated-upstream-gateway.example.workers.dev";
const fields = ["drop", "malformed", "disconnect", "ratelimit", "latency"];
const chaosOf = (values) =>
  Object.fromEntries(fields.map((field) => [`x-aimock-chaos-${field}`, values[field] ?? "0"]));
const modelCall = (path, { shape = "messages", headers = {}, stream = true } = {}) =>
  new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(requestBody(shape, false, { stream })),
  });

test("a profile prefix is stripped; any other path is not a profile", () => {
  assert.deepEqual(profileRoute("/a/v1/messages"), { profile: "a", pathname: "/v1/messages" });
  assert.deepEqual(profileRoute("/b/v1/chat/completions"), {
    profile: "b",
    pathname: "/v1/chat/completions",
  });
  assert.deepEqual(profileRoute("/b"), { profile: "b", pathname: "/" });
  assert.deepEqual(profileRoute("/a/"), { profile: "a", pathname: "/" });
  for (const path of [
    "/v1/messages",
    "/ab/v1/messages",
    "/A/v1/messages",
    "/c/v1",
    "/",
    "/_emulated/profiles/b",
  ])
    assert.equal(profileRoute(path), undefined, path);
});

test("each profile sets every chaos field to its own, whatever the caller sent", async () => {
  const aimock = fakeAimock({ key });
  const caller = { "x-aimock-chaos-ratelimit": "1", "x-aimock-chaos-drop": "1" };
  const profileB = { rateLimitRate: 0.25, latencyMs: 7000 };
  for (const shape of Object.keys(paths)) {
    const answer = await forward(
      aimock.port,
      modelCall(`/a${paths[shape]}?beta=true`, { shape, headers: caller }),
      profileB,
    );
    assert.equal(answer.status, 200, shape);
    assert.equal(verdict(shape, false, await answer.text()).pass, true, shape);
  }
  await (await forward(aimock.port, modelCall(`/b${paths.messages}`), profileB)).text();
  assert.deepEqual(
    aimock.calls.map((call) => [call.path, call.search]),
    [
      ["/v1/chat/completions", "?beta=true"],
      ["/v1/responses", "?beta=true"],
      ["/v1/messages", "?beta=true"],
      ["/v1/messages", ""],
    ],
  );
  for (const call of aimock.calls.slice(0, 3)) assert.deepEqual(call.chaos, chaosOf({}));
  assert.deepEqual(aimock.calls[3].chaos, chaosOf({ ratelimit: "0.25", latency: "7000" }));
});

test("an unprefixed call reaches the mock as it came, chaos headers and 429 included", async () => {
  const aimock = fakeAimock({ key });
  const answer = await forward(
    aimock.port,
    modelCall(paths.messages, { headers: { "x-aimock-chaos-ratelimit": "1" } }),
    { rateLimitRate: 0, latencyMs: 0 },
  );
  assert.equal(answer.status, 429);
  assert.equal(answer.headers.get("retry-after"), "1");
  assert.equal(answer.headers.get("x-ratelimit-reset-tokens"), "6m0s");
  assert.deepEqual(aimock.calls[0].chaos, { "x-aimock-chaos-ratelimit": "1" });
  assert.equal(aimock.calls[0].path, "/v1/messages");
});

test("profile b's 429 says Retry-After 15 and no other time; profile a stays clean beside it", async () => {
  // Home ends a 429 cooldown exactly at a provider time of 10 s or more; shorter only feeds its backoff.
  assert.ok(Number.isInteger(RETRY_AFTER_SECONDS) && RETRY_AFTER_SECONDS >= 10);
  const aimock = fakeAimock({ key });
  const limited = { rateLimitRate: 1, latencyMs: 0 };
  for (const shape of Object.keys(paths)) {
    const answer = await forward(aimock.port, modelCall(`/b${paths[shape]}`, { shape }), limited);
    assert.equal(answer.status, 429, shape);
    assert.equal(answer.headers.get("retry-after"), "15", shape);
    assert.deepEqual(
      [...answer.headers.keys()].filter((name) => name.startsWith("x-ratelimit-")),
      [],
      shape,
    );
    assert.equal(await answer.text(), chaos429Body, shape);
  }
  const beside = await forward(aimock.port, modelCall(`/a${paths.messages}`), limited);
  assert.equal(beside.status, 200);
  assert.equal(verdict("messages", false, await beside.text()).pass, true);
});

test("profile b's control reads and replaces both faults, refuses anything else, and never starts the mock", async () => {
  const aimock = fakeAimock({ key });
  const store = memoryStore();
  let starts = 0;
  const answer = mockCalls({
    store,
    key,
    start: async () => {
      starts++;
      return aimock.port;
    },
  });
  const url = `${origin}${profileControlPath}`;
  const read = async () => (await answer(new Request(url))).json();
  const put = (body) => answer(new Request(url, { method: "PUT", body }));
  assert.deepEqual(await read(), {
    profile: "b",
    rateLimitRate: 0,
    latencyMs: 0,
  });
  const set = await put(JSON.stringify({ rateLimitRate: 0.25, latencyMs: 12000 }));
  assert.equal(set.status, 200);
  assert.deepEqual(await read(), {
    profile: "b",
    rateLimitRate: 0.25,
    latencyMs: 12000,
  });
  for (const body of [
    { rateLimitRate: 1.5, latencyMs: 0 },
    { rateLimitRate: -0.1, latencyMs: 0 },
    { rateLimitRate: 1e-7, latencyMs: 0 },
    { rateLimitRate: "0.5", latencyMs: 0 },
    { rateLimitRate: 0.5, latencyMs: 30001 },
    { rateLimitRate: 0.5, latencyMs: 1.5 },
    { rateLimitRate: 0.5, latencyMs: -1 },
    { rateLimitRate: 0.5 },
    { rateLimitRate: 0.5, latencyMs: 0, dropRate: 1 },
    [0.5, 0],
    null,
  ]) {
    const refused = await put(JSON.stringify(body));
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.equal((await put("{not json")).status, 400);
  assert.equal((await answer(new Request(url, { method: "DELETE" }))).status, 405);
  assert.deepEqual(store.value, { rateLimitRate: 0.25, latencyMs: 12000 });
  assert.equal(starts, 0);
  // The next call through b carries what the control set; the limits are aimock's own.
  await (await answer(modelCall(`/b${paths.messages}`))).text();
  assert.equal(starts, 1);
  assert.deepEqual(aimock.calls[0].chaos, chaosOf({ ratelimit: "0.25", latency: "12000" }));
  assert.deepEqual(chaosFrom({ rateLimitRate: 1, latencyMs: 30000 }), {
    rateLimitRate: 1,
    latencyMs: 30000,
  });
});

test("the mock's own refusal still goes to the mock, behind the start", async () => {
  const aimock = fakeAimock({ key });
  const answer = mockCalls({ store: memoryStore(), key, start: async () => aimock.port });
  assert.deepEqual(await (await answer(new Request(`${origin}${refusalPath}`))).json(), {
    missing: { status: 401, aimock: true },
    wrong: { status: 401, aimock: true },
  });
});

test("the key gate refuses every route without the right key before anything answers", async () => {
  const forwarded = [];
  const next = async (request) => {
    forwarded.push(new URL(request.url).pathname);
    return new Response("{}");
  };
  const routes = [
    "/v1/models",
    `/a${paths.messages}`,
    `/b${paths.messages}`,
    `/a${paths.chat}`,
    profileControlPath,
    refusalPath,
  ];
  const wrong = [
    {},
    { authorization: "Bearer wrong-key-of-the-right-length-000000" },
    { authorization: `Bearer ${key}x` },
    { authorization: `Bearer ${key.slice(1)}` },
    { authorization: "Bearer " },
    { authorization: `bearer ${key}` },
    { authorization: key },
    { "x-api-key": "wrong" },
    { "x-api-key": "" },
  ];
  for (const path of routes)
    for (const headers of wrong)
      for (const method of ["GET", "PUT"]) {
        const answer = await gate(
          new Request(`${origin}${path}`, {
            method,
            headers,
            body: method === "PUT" ? JSON.stringify({ rateLimitRate: 1, latencyMs: 0 }) : undefined,
          }),
          key,
          next,
        );
        assert.equal(answer.status, 401, `${method} ${path} ${JSON.stringify(headers)}`);
      }
  assert.deepEqual(forwarded, []);
  for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }])
    assert.equal(
      (await gate(new Request(`${origin}${profileControlPath}`, { headers }), key, next)).status,
      200,
    );
  assert.deepEqual(forwarded, [profileControlPath, profileControlPath]);
});
