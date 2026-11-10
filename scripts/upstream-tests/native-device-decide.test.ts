import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./native-device-fixture.ts";

const selection = {
  "x-basalt-native-intent": "synthetic-intent",
  "x-basalt-native-name": "Test device",
  "x-basalt-native-pool": "pool-fixture",
  "x-basalt-native-models": "true",
  "x-basalt-native-tools": "false",
};

test("a pending native request approves on the first decision", async () => {
  let calls = 0;
  using f = await fixture(async (request) => {
    calls++;
    assert.equal(new URL(request.url).pathname, "/native/v1/control");
    return Response.json({
      computer: { id: "computer-fixture" },
      pool: "pool-fixture",
      models: true,
    });
  });
  const response = await f.request(
    "/device/decide",
    { user_code: f.user_code, accept: true },
    selection,
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { status: "approved" });
  assert.equal(calls, 1);
});

test("a failed native dependency returns a typed nonempty decision error", async () => {
  using f = await fixture(async () => {
    throw new TypeError("synthetic network failure");
  });
  const response = await f.request(
    "/device/decide",
    { user_code: f.user_code, accept: true },
    selection,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true);
  assert.deepEqual(await response.json(), {
    code: "DEVICE_APPROVAL_UNAVAILABLE",
    stage: "native_control_request",
    failure: "transport",
    message:
      "We could not confirm this device connection. Check its status on your device before trying again.",
  });
  assert.equal(
    (await f.request(`/device/request?user_code=${encodeURIComponent(f.user_code)}`)).status,
    200,
  );
});

test("native dependency diagnostics distinguish status, timeout and invalid responses", async () => {
  const cases = [
    {
      run: async () => new Response("private dependency response", { status: 503 }),
      stage: "native_control_response",
      failure: "status",
      dependencyStatus: 503,
    },
    {
      run: async () => new Response("private edge refusal", { status: 502 }),
      stage: "native_control_response",
      failure: "status",
      dependencyStatus: 502,
    },
    {
      run: async () => {
        throw new DOMException("private timeout detail", "TimeoutError");
      },
      stage: "native_control_request",
      failure: "timeout",
    },
    {
      run: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("private body timeout", "TimeoutError"));
            },
          }),
        ),
      stage: "native_control_response",
      failure: "timeout",
    },
    {
      run: async () => new Response("private unreadable body"),
      stage: "native_control_response",
      failure: "invalid_response",
    },
    {
      run: async () => Response.json({ private: "wrong response schema" }),
      stage: "native_control_response",
      failure: "invalid_response",
    },
  ];
  for (const { run, ...expected } of cases) {
    using f = await fixture(run);
    const response = await f.request(
      "/device/decide",
      { user_code: f.user_code, accept: true },
      selection,
    );
    assert.equal(response.status, 503);
    const value = await response.json();
    assert.deepEqual(value, {
      ...expected,
      code: "DEVICE_APPROVAL_UNAVAILABLE",
      message:
        "We could not confirm this device connection. Check its status on your device before trying again.",
    });
    assert.equal(JSON.stringify(value).includes("private"), false);
    assert.equal(
      (await f.request(`/device/request?user_code=${encodeURIComponent(f.user_code)}`)).status,
      200,
    );
  }
});

test("signing failures are named before any native subrequest", async () => {
  let calls = 0;
  using f = await fixture(async () => {
    calls++;
    return Response.json({});
  }, "invalid-synthetic-signing-key");
  const response = await f.request(
    "/device/decide",
    { user_code: f.user_code, accept: true },
    selection,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    code: "DEVICE_APPROVAL_UNAVAILABLE",
    stage: "native_control_signing",
    failure: "signing",
    message:
      "We could not confirm this device connection. Check its status on your device before trying again.",
  });
  assert.equal(calls, 0);
});

test("native authorization refusals retain their 401 without becoming an outage", async () => {
  using f = await fixture(async () => new Response("private refusal", { status: 401 }));
  const response = await f.request(
    "/device/decide",
    { user_code: f.user_code, accept: true },
    selection,
  );
  assert.equal(response.status, 401);
  const value = await response.json();
  assert.equal(value.code, "NATIVE_CONTROL_REFUSED");
  assert.equal(JSON.stringify(value).includes("private"), false);
});

test("grant and consent storage failures identify the write that failed", async () => {
  for (const [model, stage] of [
    ["mcpGrant", "grant_record"],
    ["oauthConsent", "consent_record"],
  ]) {
    using f = await fixture(async (request) => {
      const { envelope } = await request.json();
      const { action } = JSON.parse(Buffer.from(envelope.split(".")[1], "base64url").toString());
      return Response.json(
        action === "revoke"
          ? { revoked: true }
          : {
              computer: { id: "computer-fixture" },
              pool: "pool-fixture",
              models: true,
            },
      );
    });
    Object.freeze(f.db[model!]);
    const response = await f.request(
      "/device/decide",
      { user_code: f.user_code, accept: true },
      selection,
    );
    assert.equal(response.status, 503);
    const value = await response.json();
    assert.equal(value.code, "DEVICE_APPROVAL_UNAVAILABLE");
    assert.equal(value.stage, stage);
    assert.equal(value.failure, "storage");
  }
});
