import assert from "node:assert/strict";
import { test } from "node:test";
import { containerRequest } from "./container-request.ts";

test("a public request reaches the container over plain HTTP with everything else intact", async () => {
  const request = new Request("https://app.signalbox.run/v1/chat/completions?stream=true", {
    method: "POST",
    headers: { authorization: "Bearer fixture", "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture" }),
  });
  const forwarded = containerRequest(request);
  assert.equal(forwarded.url, "http://pool/v1/chat/completions?stream=true");
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.get("authorization"), "Bearer fixture");
  assert.equal(forwarded.headers.get("content-type"), "application/json");
  assert.deepEqual(await forwarded.json(), { model: "fixture" });
  assert.equal(containerRequest(new Request("https://app.signalbox.run/v1/models")).url, "http://pool/v1/models");
});
