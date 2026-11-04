import assert from "node:assert/strict";
import { test } from "node:test";

const contracts = new URL("../../.upstream/packages/ui/src/contracts/", import.meta.url);
const { brandLab, brandFill } = (await import(new URL("provider-brand.ts", contracts).href)) as {
  brandLab: (...names: (string | null | undefined)[]) => string | undefined;
  brandFill: (lab: string | undefined) => string | undefined;
};

test("providers and models map to one lab wherever they show", () => {
  assert.equal(brandLab("ChatGPT"), "openai");
  assert.equal(brandLab("codex"), "openai");
  assert.equal(brandLab("gpt-5.5"), "openai");
  assert.equal(brandLab("Claude"), "anthropic");
  assert.equal(brandLab("claude-opus-5-5"), "anthropic");
  assert.equal(brandLab("Kimi"), "kimi");
  assert.equal(brandLab("moonshot-v1"), "kimi");
  assert.equal(brandLab("Gmail"), undefined);
  // The most specific name wins: a Claude model served by another provider stays Anthropic.
  assert.equal(brandLab("claude-sonnet", "openrouter"), "anthropic");
  assert.equal(brandLab(undefined, "", "OpenAI"), "openai");
});

test("OpenAI is green, Anthropic orange and Kimi blue; others have no brand fill", () => {
  assert.match(brandFill("openai") ?? "", /#10a37f/);
  assert.match(brandFill("anthropic") ?? "", /#d97757/);
  assert.match(brandFill("kimi") ?? "", /#1783ff/);
  assert.equal(brandFill(undefined), undefined);
});
