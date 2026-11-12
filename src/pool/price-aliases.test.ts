import assert from "node:assert/strict";
import { test } from "node:test";
import { priceAliases } from "./price-aliases.ts";

test("dated and provider-prefixed Claude spellings produce fallbacks without changing exact targets", () => {
  assert.deepEqual(
    priceAliases([
      { provider: "claude", model: "anthropic/claude-opus-5.5-20261101" },
      { provider: "codex", model: "openai/gpt-6.1-sol-2026-11-01" },
    ]),
    [
      {
        target_model: "anthropic/claude-opus-5.5-20261101",
        source_models: ["claude-opus-5.5", "claude-opus-5-5"],
      },
      { target_model: "openai/gpt-6.1-sol-2026-11-01", source_models: ["gpt-6.1-sol"] },
    ],
  );
});

test("current exact IDs need no per-model aliases, and unknown families never get a guessed price", () => {
  assert.deepEqual(
    priceAliases([
      { provider: "claude", model: "claude-opus-5-5" },
      { provider: "codex", model: "gpt-6.1-sol" },
      { provider: "claude", model: "new-unknown-model" },
      { provider: "claude", model: "claude-opus-5-5-20260230" },
    ]),
    [],
  );
});

test("date aliases do not broaden Home's existing preview, latest or thinking normalization", () => {
  assert.deepEqual(
    priceAliases([
      { provider: "codex", model: "gpt-6.1-sol-preview" },
      { provider: "codex", model: "gpt-6.1-sol-latest" },
      { provider: "codex", model: "gpt-6.1-sol-thinking" },
      { provider: "codex", model: "gpt-6.1-sol-20261101-preview" },
    ]),
    [],
  );
});

test("future Claude families and multi-part versions need no model-name list", () => {
  assert.deepEqual(
    priceAliases([{ provider: "claude", model: "claude-future-family-8.2.1-20261101" }]),
    [
      {
        target_model: "claude-future-family-8.2.1-20261101",
        source_models: ["claude-future-family-8.2.1", "claude-future-family-8-2-1"],
      },
    ],
  );
});
