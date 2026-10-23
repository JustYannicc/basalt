import assert from "node:assert/strict";
import { test } from "node:test";
import { callbackOrigin, isLoopbackUrl } from "./sign-in.ts";

test("only local addresses count as the pasted callback", () => {
  assert.ok(isLoopbackUrl("http://localhost:5000/callback?code=c&state=s"));
  assert.ok(isLoopbackUrl("http://127.0.0.1:5000/cb"));
  assert.ok(isLoopbackUrl("http://[::1]:5000/cb"));
  assert.equal(isLoopbackUrl("https://example.com/callback?code=c"), false);
  assert.equal(isLoopbackUrl("code#state"), false);
  assert.equal(isLoopbackUrl("javascript:alert(1)"), false);
});

test("the expected local address comes from the sign-in link itself", () => {
  const link = `https://auth.example.com/authorize?client_id=x&redirect_uri=${encodeURIComponent("http://localhost:5000/callback")}`;
  assert.equal(callbackOrigin(link), "http://localhost:5000");
  assert.equal(callbackOrigin("https://auth.example.com/device?code=1"), null);
  assert.equal(callbackOrigin(`https://a.example.com/?redirect_uri=${encodeURIComponent("https://b.example.com/cb")}`), null);
  assert.equal(callbackOrigin("not a url"), null);
});
