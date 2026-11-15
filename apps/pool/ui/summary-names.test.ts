import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryLabName } from "./summary-names.ts";

const providers = [
  { id: "codex", name: "ChatGPT", site: "example.test" },
  { id: "claude", name: "Claude", site: "example.test" },
  { id: "xai", name: "Grok", site: "example.test" },
  { id: "kimi", name: "Authoritative lab name", site: "example.test" },
];

test("summary lab names stay neutral until their authoritative name is available", () => {
  assert.equal(summaryLabName([], "codex"), "…");
  assert.equal(summaryLabName([], "claude"), "…");
  assert.equal(summaryLabName(providers, "not-in-the-view"), "…");
});

// The approved overview mock names labs, not products: OpenAI, Anthropic and xAI.
test("summary lab names show the lab behind a subscription product", () => {
  assert.equal(summaryLabName(providers, "codex"), "OpenAI");
  assert.equal(summaryLabName(providers, "claude"), "Anthropic");
  assert.equal(summaryLabName(providers, "xai"), "xAI");
});

test("summary lab names use the pool view's exact name for every other provider", () => {
  assert.equal(summaryLabName(providers, "kimi"), "Authoritative lab name");
});

test("unattributed summary usage remains an unknown lab", () => {
  assert.equal(summaryLabName(providers, null), "Unknown lab");
});
