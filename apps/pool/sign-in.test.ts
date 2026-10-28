import assert from "node:assert/strict";
import { test } from "node:test";
import { callbackOrigin, identityOf, isLoopbackUrl, prompt, signedIn } from "./sign-in.ts";

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

test("a callback sign-in asks the Connect dialog for the address the tab ends on", () => {
  const url = `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent("http://localhost:5000/callback")}`;
  const shown = prompt.signIn({ session: "s", provider: "p", flow: "callback", url, userCode: null, expiresAt: "2026-01-01T00:10:00Z" });
  assert.equal(shown.session, "s");
  assert.equal(shown.url, url);
  assert.equal("code" in shown, false);
  assert.equal(shown.paste?.placeholder, "http://localhost:5000/…");
  assert.match(shown.paste?.label ?? "", /http:\/\/localhost:5000/);
  assert.equal(shown.expiresAt, Date.parse("2026-01-01T00:10:00Z"));
});

test("a device sign-in shows its code and asks for nothing back", () => {
  const shown = prompt.signIn({
    session: "s",
    provider: "p",
    flow: "device",
    url: "https://auth.example.com/device",
    userCode: "ABCD-1234",
    expiresAt: "2026-01-01T00:10:00Z",
  });
  assert.equal(shown.code, "ABCD-1234");
  assert.equal("paste" in shown, false);
});

test("the pool account becomes the account's reference; an unattributed one fails closed", () => {
  assert.deepEqual(signedIn({ status: "waiting" }), { state: "waiting" });
  assert.deepEqual(signedIn({ status: "connected", accountId: "a1" }), { state: "connected", ref: "a1" });
  assert.deepEqual(signedIn({ status: "failed", message: "no" }), { state: "failed", message: "no" });
  assert.equal(signedIn({ status: "connected", accountId: null }).state, "failed");
});

test("a connected subscription reports its email or label, and its provider's logo", () => {
  const sites = [{ id: "codex", site: "chatgpt.com" }, { id: "kimi" }];
  assert.deepEqual(identityOf({ label: "someone@example.com", provider: "codex" }, sites), {
    displayName: "someone@example.com",
    email: "someone@example.com",
    avatarUrl: "https://integrations.sh/logo/chatgpt.com?sz=64",
  });
  assert.deepEqual(identityOf({ label: "Team login", provider: "kimi" }, sites), { displayName: "Team login" });
  assert.deepEqual(identityOf({ label: "  ", provider: "other" }, sites), {});
});
