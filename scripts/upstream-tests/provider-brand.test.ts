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

const styles = new URL("../../.upstream/packages/ui/src/implementation/styles/", import.meta.url);
const read = async (name: string) =>
  (await import("node:fs/promises")).readFile(new URL(name, styles), "utf8");

const luminance = (hex: string) => {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
};
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
};
const expand = (hex: string) =>
  hex.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join("")}` : hex;

test("every lab shade keeps at least 3:1 against the page on both themes", async () => {
  const globals = await read("globals.css");
  const backgrounds = [...globals.matchAll(/--background:\s*(#[0-9a-f]{3,6})\b/gi)].map((m) =>
    expand(m[1]!.toLowerCase()),
  );
  const [light, dark] = backgrounds as [string, string];
  assert.equal(backgrounds.length, 2, "one light and one dark page background");
  const shades = [
    ...(await read("dashboard.css")).matchAll(
      /(--brand-[a-z]+(?:-\d)?):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi,
    ),
  ];
  // Four labs, each with its own colour and two extra series shades.
  assert.equal(shades.length, 12);
  for (const [, name, onLight, onDark] of shades) {
    assert.ok(contrast(onLight!, light) >= 3, `${name} on the light page`);
    assert.ok(contrast(onDark!, dark) >= 3, `${name} on the dark page`);
  }
  // A healthy usage bar fills with the lab's own colour over the meter track (`bg-border`).
  const tracks = [...globals.matchAll(/--border:\s*(#[0-9a-f]{3,6})\b/gi)].map((m) =>
    expand(m[1]!.toLowerCase()),
  );
  const [lightTrack, darkTrack] = tracks as [string, string];
  assert.equal(tracks.length, 2, "one light and one dark meter track");
  const bars = shades.filter(([, name]) => !/-\d$/.test(name!));
  assert.equal(bars.length, 4);
  for (const [, name, onLight, onDark] of bars) {
    assert.ok(contrast(onLight!, lightTrack) >= 3, `${name} on the light meter track`);
    assert.ok(contrast(onDark!, darkTrack) >= 3, `${name} on the dark meter track`);
  }
});
