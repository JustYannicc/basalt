import assert from "node:assert/strict";
import test from "node:test";
import {
  availableProviderCapabilities,
  quotaProviderIds,
} from "./provider-accounts/capabilities.ts";

test("quota capability names only collectors supported by the pinned Home backend", () => {
  assert.deepEqual(quotaProviderIds, ["codex", "claude", "antigravity", "kimi", "xai", "meta"]);
  const keys = availableProviderCapabilities.filter(
    (entry) =>
      entry.method === "apiKey" ||
      entry.connection === "token-mirror" ||
      entry.connection === "credential-mirror" ||
      entry.lab === "cloudflare",
  );
  assert.equal(keys.length, 12);
  assert.ok(keys.every((entry) => entry.quota === "none"));
  assert.deepEqual(
    availableProviderCapabilities
      .filter((entry) => entry.connection === "home-oauth" && entry.quota === "none")
      .map((entry) => `${entry.lab}/${entry.method}`),
    ["gemini/geminiCli", "kimi/kimi-ai", "devin/devin"],
  );
});
