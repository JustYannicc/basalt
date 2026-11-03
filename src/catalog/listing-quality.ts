import { inflateSync } from "node:zlib";
import type { FeedEntry } from "./feed.ts";

/*
 * What a catalog card needs to read like every other one: a logo that fills its tile and shows on
 * both themes, and one plain sentence about what the person can do. Tests run these over every
 * listing Basalt writes; the worker never imports them.
 */

// The tile is drawn on the theme background (upstream `--background`) and the logo is contained in it.
const backgrounds = { light: [255, 255, 255], dark: [10, 10, 10] } as const;
type Theme = keyof typeof backgrounds;
const minimum = { size: 64, fill: 0.8, coverage: 0.1, contrasted: 0.5, contrast: 3 };

// Words a person shouldn't need to know. REST matches by case so "rest" stays plain English.
const jargon = [
  /\bREST\b/,
  /\b(APIs?|OpenAPI|GraphQL|OAuth|SDK|JSON|MCP|HTTP|CRUD|endpoints?|mutations?|reads and writes|caller identity|credentials?|access (?:keys?|tokens?))\b/i,
];
// Approval and plan notices belong on the connection screen, not the card. "Approve expenses" is a task, not a notice.
const notice =
  /\bapproval\b|\b(?:requires?|required|needs?)\b[^.]*?\b(?:admin|enterprise|plans?)\b|\b(?:enterprise|paid|business) plans?\b|\bplans? only\b|\bsome (?:require|need)\b/i;

export function descriptionProblems(text: string): string[] {
  const problems: string[] = [];
  const quoted = JSON.stringify(text);
  const sentence = text.replace(/\b(?:e\.g|i\.e|etc)\./g, "");
  if (text.length > 140) problems.push(`description is ${text.length} characters, over 140: ${quoted}`);
  if (!sentence.endsWith(".") || /;|[.!?]\s+\S/.test(sentence))
    problems.push(`description must be one plain sentence ending in a full stop: ${quoted}`);
  for (const pattern of jargon) {
    const word = text.match(pattern)?.[0];
    if (word) problems.push(`description uses jargon "${word}": ${quoted}`);
  }
  const notes = text.match(notice)?.[0];
  if (notes) problems.push(`description carries a notice ("${notes}"); say what the person can do instead: ${quoted}`);
  return problems;
}

export function iconProblems(icons: readonly FeedEntry["icons"][number][]): string[] {
  if (icons.length === 0) return ["has no logo"];
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  // Upstream's choice: the icon made for the theme, else one without a theme, else the first.
  const shown = (theme: Theme) =>
    icons.find(icon => icon.theme === theme) ?? icons.find(icon => icon.theme === undefined) ?? icons[0]!;
  const problems: string[] = [];
  // Crop and size don't depend on the theme, so a shared icon reports them once.
  const sources = [...new Set([shown("light").src, shown("dark").src])];
  const rasters = new Map(sources.map(src => [src, rasterOf(src)]));
  for (const theme of sources.length === 1 ? [undefined] : (["light", "dark"] as const)) {
    const label = theme ? `${theme} logo` : "logo";
    const raster = rasters.get(shown(theme ?? "light").src)!;
    if (typeof raster === "string") {
      problems.push(`${label} ${raster}`);
      continue;
    }
    const { size, fill, coverage } = shape(raster);
    if (size < minimum.size) problems.push(`${label} is ${size}px, under ${minimum.size}px`);
    if (fill < minimum.fill) problems.push(`${label} is badly cropped: its mark spans ${percent(fill)} of the image`);
    if (coverage < minimum.coverage) problems.push(`${label} is mostly transparent: it draws ${percent(coverage)} of its tile`);
  }
  for (const theme of ["light", "dark"] as const) {
    const raster = rasters.get(shown(theme).src)!;
    if (typeof raster === "string") continue;
    const visible = contrasted(raster, backgrounds[theme]);
    if (visible < minimum.contrasted)
      problems.push(`logo barely shows on the ${theme} theme: ${percent(visible)} of it reaches ${minimum.contrast}:1 contrast`);
  }
  return problems;
}

function rasterOf(src: string): Raster | string {
  const png = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(src);
  if (!png) return "must be an inline PNG data URL so its crop can be checked";
  try {
    return decodePng(Buffer.from(png[1]!, "base64"));
  } catch (error) {
    return `can't be read: ${(error as Error).message}`;
  }
}

interface Raster { width: number; height: number; rgba: Uint8Array }

// A pixel counts as drawn from this opacity; fainter ones are anti-aliasing.
const drawn = 0.1;

/** How much of the square tile a logo fills once contained in it. */
function shape({ width, height, rgba }: Raster) {
  const side = Math.max(width, height);
  let left = width, top = height, right = -1, bottom = -1, ink = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const alpha = rgba[(y * width + x) * 4 + 3]! / 255;
    ink += alpha;
    if (alpha < drawn) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const span = right < 0 ? 0 : Math.max(right - left + 1, bottom - top + 1);
  return { size: side, fill: span / side, coverage: ink / (side * side) };
}

/** The share of a logo's drawn pixels that reach the contrast minimum over `background`. */
function contrasted({ rgba }: Raster, background: readonly number[]): number {
  const ground = luminance(background);
  let visible = 0, seen = 0;
  for (let at = 0; at < rgba.length; at += 4) {
    const alpha = rgba[at + 3]! / 255;
    if (alpha < drawn) continue;
    const lit = luminance([0, 1, 2].map(channel => rgba[at + channel]! * alpha + background[channel]! * (1 - alpha)));
    seen += alpha;
    if ((Math.max(lit, ground) + 0.05) / (Math.min(lit, ground) + 0.05) >= minimum.contrast) visible += alpha;
  }
  return seen ? visible / seen : 0;
}

function luminance(rgb: readonly number[]): number {
  const [r, g, b] = rgb.map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Decodes the 8-bit, non-interlaced PNGs logos ship as; anything else is reported, not guessed. */
function decodePng(bytes: Uint8Array): Raster {
  const view = Buffer.from(bytes);
  if (view.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("not a PNG");
  let offset = 8, width = 0, height = 0, channels = 0;
  const data: Buffer[] = [];
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString("latin1", offset + 4, offset + 8);
    const body = view.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[body[9]!] ?? 0;
      if (body[8] !== 8 || channels === 0 || body[12] !== 0)
        throw new Error("the PNG must be 8-bit grayscale or RGB, with or without alpha, and not interlaced");
    } else if (type === "tRNS") throw new Error("the PNG keys transparency on a color; export it with an alpha channel");
    else if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("the PNG image data is truncated");
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a
        : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      if (predictor === undefined) throw new Error(`the PNG has unknown row filter ${filter}`);
      pixels[y * stride + x] = (value + predictor) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const pixel = pixels.subarray(i * channels, i * channels + channels);
    const gray = channels < 3;
    rgba.set([pixel[0]!, gray ? pixel[0]! : pixel[1]!, gray ? pixel[0]! : pixel[2]!,
      channels === 2 ? pixel[1]! : channels === 4 ? pixel[3]! : 255], i * 4);
  }
  return { width, height, rgba };
}
