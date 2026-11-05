import assert from "node:assert/strict";
import { test } from "node:test";
import { identityOf } from "./account-identity.ts";

test("a connected subscription reports its email or label, and its provider's logo", () => {
  const sites = [{ id: "codex", site: "chatgpt.com" }, { id: "kimi" }];
  assert.deepEqual(identityOf({ label: "someone@example.com", provider: "codex" }, sites), {
    displayName: "someone@example.com",
    email: "someone@example.com",
    avatarUrl: "https://integrations.sh/logo/chatgpt.com?sz=64",
  });
  assert.deepEqual(identityOf({ label: "Team login", provider: "kimi" }, sites), {
    displayName: "Team login",
  });
  assert.deepEqual(identityOf({ label: "  ", provider: "other" }, sites), {});
});
