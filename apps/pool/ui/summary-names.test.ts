import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryLabName, summaryLabExplanation } from "./summary-names.ts";

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

test("unknown labs explain gateway refusals without attributing other missing or withheld requests", () => {
  const groups = [
    {
      provider: null,
      countsOnly: false,
      buckets: [{ requests: 153, failed: 153, refusedBeforeLab: 153 }],
    },
    { provider: null, countsOnly: false, buckets: [{ requests: 2, failed: 1 }] },
    { provider: null, countsOnly: true, buckets: [{ requests: 3, failed: 0 }] },
    {
      provider: "xai",
      countsOnly: false,
      buckets: [{ requests: 7, failed: 7, refusedBeforeLab: 7 }],
    },
  ];
  assert.equal(
    summaryLabExplanation(groups),
    "153 failed before reaching a lab. 2 requests have no lab recorded; 1 failed. Lab details are withheld for 3 requests from accounts you can't inspect.",
  );
  assert.equal(summaryLabExplanation([groups[3]!]), null);
  assert.equal(
    summaryLabExplanation([
      { provider: null, countsOnly: false, buckets: [{ requests: 1, failed: 0 }] },
    ]),
    "1 request has no lab recorded.",
  );
});
