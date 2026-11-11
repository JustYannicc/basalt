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

async function authorized() {
  const actions: string[] = [];
  const f = await fixture(async (request) => {
    const { envelope } = await request.json();
    const { action } = JSON.parse(Buffer.from(envelope.split(".")[1], "base64url").toString());
    actions.push(action);
    return Response.json(
      action === "register"
        ? { computer: { id: "computer-fixture" }, pool: "pool-fixture", models: true }
        : action === "check"
          ? { active: true }
          : { revoked: true },
    );
  });
  try {
    const approved = await f.request(
      "/device/decide",
      { user_code: f.user_code, accept: true },
      selection,
    );
    assert.equal(approved.status, 200);
    const token = await f.raw("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: f.device_code,
        client_id: f.client_id,
        code_verifier: f.verifier,
        resource: "http://localhost:3000/native",
      }),
    });
    assert.equal(token.status, 200, "the fixture must issue a real native bearer");
    const { access_token } = await token.json();
    assert.equal(typeof access_token, "string");
    return { ...f, actions, headers: { authorization: `Bearer ${access_token}` } };
  } catch (error) {
    f[Symbol.dispose]();
    throw error;
  }
}

for (const body of [undefined, new Uint8Array(0)]) {
  test(`native revoke accepts an authenticated empty ${body === undefined ? "absent" : "streamed"} body`, async () => {
    using f = await authorized();
    const response = await f.raw("/native/revoke", { method: "POST", headers: f.headers, body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { revoked: true });
    assert.equal(f.actions.filter((action) => action === "revoke").length, 1);
    assert.equal(
      (await f.raw("/native/revoke", { method: "POST", headers: f.headers })).status,
      401,
    );
  });
}

test("bare native revoke still requires a bearer", async () => {
  using f = await fixture();
  for (const body of [undefined, new Uint8Array(0)])
    assert.equal((await f.raw("/native/revoke", { method: "POST", body })).status, 401);
});

test("an empty untyped body on another auth route keeps its original refusal", async () => {
  using f = await fixture();
  assert.equal(
    (await f.raw("/device/decide", { method: "POST", body: new Uint8Array(0) })).status,
    415,
  );
});

test("native revoke still accepts an authenticated JSON object", async () => {
  using f = await authorized();
  const response = await f.raw("/native/revoke", {
    method: "POST",
    headers: { ...f.headers, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: true });
});

for (const [contentType, body, status] of [
  [undefined, "non-json", 415],
  ["text/plain", "non-json", 415],
  ["application/x-www-form-urlencoded", "revoke=true", 415],
  ["application/json", "{", 400],
] as const) {
  test(`native revoke refuses nonempty ${contentType ?? "untyped"} bodies without revoking`, async () => {
    using f = await authorized();
    const response = await f.raw("/native/revoke", {
      method: "POST",
      headers: { ...f.headers, ...(contentType ? { "content-type": contentType } : {}) },
      body: new TextEncoder().encode(body),
    });
    assert.equal(response.status, status);
    assert.equal(f.actions.includes("revoke"), false);
  });
}
