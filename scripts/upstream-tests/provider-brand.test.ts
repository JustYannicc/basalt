import assert from "node:assert/strict";
import { test } from "node:test";

type Input = { model?: string; providers?: (string | null | undefined)[] };
const lib = new URL("../../.upstream/packages/ui/src/implementation/lib/", import.meta.url);
const { brandLab, brandFill } = (await import(new URL("provider-brand.ts", lib).href)) as {
  brandLab: (input: Input) => string | undefined;
  brandFill: (lab: string | undefined, shade?: number) => string | undefined;
};

test("a model's family names its lab before any provider", () => {
  assert.equal(brandLab({ model: "claude-opus-5-5", providers: ["OpenAI"] }), "anthropic");
  assert.equal(brandLab({ model: "gpt-5.5" }), "openai");
  assert.equal(brandLab({ model: "o3-mini" }), "openai");
  assert.equal(brandLab({ model: "kimi-k2" }), "kimi");
  assert.equal(brandLab({ model: "gemini-2.5-pro" }), "google");
});

test("providers match only their exact known names, never a substring", () => {
  assert.equal(brandLab({ providers: ["ChatGPT"] }), "openai");
  assert.equal(brandLab({ providers: ["codex"] }), "openai");
  assert.equal(brandLab({ providers: ["Claude"] }), "anthropic");
  assert.equal(brandLab({ providers: ["Kimi"] }), "kimi");
  assert.equal(brandLab({ providers: ["openai-compatible"] }), undefined);
  assert.equal(brandLab({ providers: ["kimiko"] }), undefined);
  assert.equal(brandLab({ model: "kimiko-7b" }), undefined);
  assert.equal(brandLab({ providers: ["OpenRouter"] }), undefined);
  assert.equal(brandLab({ providers: [undefined, "", "Anthropic"] }), "anthropic");
});

test("the fill is one shared class per lab, with bounded tints", () => {
  assert.equal(brandFill("openai"), "brand-fill brand-openai");
  assert.equal(brandFill("kimi", 1), "brand-fill brand-kimi brand-shade-1");
  assert.equal(brandFill("anthropic", 9), "brand-fill brand-anthropic brand-shade-2");
  assert.equal(brandFill(undefined), undefined);
});
