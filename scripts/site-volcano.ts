/**
 * Renders the home page's volcano as ordered dither: a 4×4 Bayer matrix over a smooth field, one
 * pixel per cell, scaled up by the page with crisp edges. Grey tones carry the mountain and the
 * ash; only heat (the vent, the fountain, lava and flying bombs) takes the ember accent.
 *
 * It tells one story in two files. The intro plays once: the mountain sits quiet, rumbles, then
 * blows. The loop carries on from there. The intro lasts an exact number of loop periods, so the
 * page can hand over at the matching frame. A still serves reduced motion.
 *
 *   node scripts/site-volcano.ts   (needs img2webp from libwebp)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
// The intro ends once the blast has settled and every puff alive was born steady.
import { height, introSeconds, loopSeconds, width } from "../src/site/volcano.ts";
import { run } from "./process.ts";
/** Seconds per frame. */
const step = 0.08;
/** When the mountain blows, and how long the blast takes to settle into a steady eruption. */
const blast = 1.6;
const settle = 3.2;
/** Puffs of ash leave the vent this often and live this long; the loop is a whole number of both. */
const puffEvery = 0.4;
const puffLife = 4.8;

/** Page black, charcoal, warm grey, bone; then deep and bright ember for heat only. */
const greys = [
  [0x09, 0x09, 0x0b],
  [0x2a, 0x2a, 0x2d],
  [0x7d, 0x7c, 0x78],
  [0xec, 0xeb, 0xe6],
] as const;
const embers = [
  [0x8a, 0x2b, 0x12],
  [0xff, 0x6a, 0x2b],
] as const;
const bayer = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const fract = (value: number) => value - Math.floor(value);
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const smoothstep = (from: number, to: number, value: number) => {
  const k = clamp((value - from) / (to - from));
  return k * k * (3 - 2 * k);
};
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

/** Low-octave value noise, so the field reads as mass rather than grain. */
function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smoothstep(0, 1, x - ix);
  const fy = smoothstep(0, 1, y - iy);
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * fx;
  const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * fx;
  return top + (bottom - top) * fy;
}

/**
 * Noise drifting up the page at `speed` (down when negative) that still repeats every loop: two
 * drifts a loop apart, crossfaded across it, with their contrast kept where they mix.
 */
function drift(x: number, y: number, time: number, speed: number): number {
  const mix = fract(time / loopSeconds);
  const span = speed * loopSeconds;
  const blend = noise(x, y + mix * span) * (1 - mix) + noise(x, y - (1 - mix) * span) * mix;
  return clamp(0.5 + (blend - 0.5) / Math.hypot(1 - mix, mix));
}

const crater = { x: 0.48, y: 0.62 };
/** The cone's half-width below the crater, slightly concave, with a lumpy outline. */
const slope = (x: number, y: number) =>
  0.05 + Math.pow(Math.max(0, y - crater.y) / (1 - crater.y), 0.85) * 0.46 + (noise(y * 22, x * 3) - 0.5) * 0.025;

/** How hard the vent is going for a puff or bomb born at `time`: a big blast settling to steady. */
const strength = (time: number) => 1 + 1.6 * (1 - smoothstep(0, settle, time - blast));
/** Before the blast the vent only rumbles: a glow that swells, and a thin wisp. */
const rumble = (time: number) => smoothstep(0, blast, time) * (0.7 + 0.3 * Math.sin(time * 19));

interface Cell {
  /** Grey brightness, 0..1. */
  readonly tone: number;
  /** Heat, 0..1; hot enough cells take the ember accent instead of grey. */
  readonly heat: number;
}

/** The scene at a point (x, y in 0..1, y down) and a time in seconds since the page loaded. */
export function field(x: number, y: number, time: number): Cell {
  let tone = 0;
  let heat = 0;
  const erupting = time >= blast;
  // The cone, lit from the left and ridged, fading out at its foot instead of meeting a hard edge.
  const half = slope(x, y);
  const across = (x - crater.x) / half;
  if (y >= crater.y && Math.abs(across) <= 1) {
    const depth = (y - crater.y) / (1 - crater.y);
    const ridges = noise(x * 18, y * 6) * 0.12;
    const foot = 1 - smoothstep(0.62, 0.98, depth + (noise(x * 9, 1) - 0.5) * 0.18);
    tone = Math.max(tone, (0.36 - across * 0.16 + ridges - depth * 0.12) * foot * (1 - smoothstep(0.82, 1, Math.abs(across))));
    // Lava runs grow down the flanks after the blast and keep flowing.
    if (erupting) {
      const reach = smoothstep(0, 2.4, time - blast) * 0.85;
      for (const [side, bend] of [[-0.42, 0.07], [0.32, -0.05], [0.06, 0.03]] as const) {
        const course = side * depth + Math.sin(depth * 9 + side * 7) * bend;
        const distance = Math.abs(across - course) * half;
        const run = Math.max(0, 1 - depth / Math.max(0.01, reach * (1 - Math.abs(side) * 0.4)));
        const flicker = 0.8 + 0.2 * Math.sin(((time - blast) / 2.4 + depth * 1.5) * Math.PI * 2);
        heat = Math.max(heat, Math.max(0, 1 - distance / 0.02) * run * flicker);
      }
    }
  }
  // The vent glows: a swelling rumble before the blast, steady heat after it.
  const glow = Math.max(0, 1 - Math.hypot((x - crater.x) * 1.6, (y - crater.y) * 3) / 0.12);
  heat = Math.max(heat, glow * (erupting ? 1 : rumble(time) * 0.8));
  // Ash: puffs born at the vent rise, swell and cool. Before the blast only a faint wisp rises.
  let ash = 0;
  let light = 0;
  // A hair over, so a puff born on this very frame counts despite float rounding.
  const newest = Math.floor(time / puffEvery + 1e-9);
  const puffsPerLoop = Math.round(loopSeconds / puffEvery);
  for (let born = newest; born > newest - puffLife / puffEvery - 1; born -= 1) {
    const birth = born * puffEvery;
    const age = (time - birth) / puffLife;
    if (age < 0 || age >= 1) continue;
    const blown = birth >= blast;
    const force = blown ? strength(birth) : 0.25;
    const phase = Math.min(1, age * (blown ? 0.75 + 0.25 * force : 0.8));
    // Each puff's sway and lobes come from its place in the loop, so the loop closes on itself.
    const seed = ((born % puffsPerLoop) + puffsPerLoop) % puffsPerLoop;
    const cx = crater.x + Math.sin(phase * 3 + seed * 1.7) * 0.05 * phase + phase * 0.05;
    const cy = crater.y - 0.04 - Math.pow(phase, 0.8) * 0.4;
    const radius = (0.03 + Math.pow(phase, 0.9) * 0.16) * (blown ? 0.8 + 0.2 * force : 0.5);
    for (let lobe = 0; lobe < 3; lobe += 1) {
      const angle = seed * 2.4 + lobe * 2.1;
      const lx = cx + Math.cos(angle) * radius * 0.45;
      const ly = cy + Math.sin(angle) * radius * 0.3;
      const distance = Math.hypot(x - lx, (y - ly) * 1.1) / (radius * 0.75);
      if (distance >= 1) continue;
      const density = (1 - distance * distance) * Math.pow(1 - age, 0.8) * (blown ? 1 : 0.35);
      ash += density;
      light += density * Math.max(0, ((lx - x) * 0.8 + (ly - y) * 0.6) / radius);
    }
  }
  if (ash > 0) {
    const billow = drift(x * 16, y * 16, time, -1.6) * 0.6 + noise(x * 34, y * 34) * 0.4;
    const cover = 1 - Math.exp(-ash * 1.8);
    tone = Math.max(tone, cover * (0.12 + billow * 0.42) + Math.min(0.5, light * 0.75));
  }
  // A lava fountain stands over the vent once it blows, tallest in the blast.
  if (erupting) {
    const rise = crater.y - y;
    const fountain = (0.12 + 0.04 * Math.sin(((time - blast) / 1.2) * Math.PI * 2)) * strength(time);
    if (rise > -0.01 && rise < fountain) {
      const spread = 0.012 + rise * 0.3;
      const core = Math.min(1, Math.max(0, 1 - Math.abs(x - crater.x) / spread) * 1.6);
      heat = Math.max(heat, core * (1.15 - rise / fountain) * (0.75 + 0.25 * drift(x * 60, y * 60, time, 2)));
    }
  }
  // Bombs: a burst at the blast, then a steady scatter. Each is one hot cell with a cooling trail.
  const bombs: Array<[number, number]> = [];
  for (let index = 0; index < 18; index += 1) bombs.push([blast + hash(index, 11) * 0.3, index]);
  const every = 0.6;
  const latest = Math.floor(time / every + 1e-9);
  for (let k = latest; k > latest - 4; k -= 1) if (k * every >= blast + 0.6) bombs.push([k * every, 100 + (k % 8)]);
  for (const [launched, seed] of bombs) {
    const flight = time - launched;
    if (flight < 0 || flight > 2) continue;
    const burst = launched < blast + 0.5;
    const vx = (hash(seed, 3) - 0.5) * 0.5 * (burst ? 1.6 : 1);
    const vy = (0.45 + hash(seed, 7) * 0.4) * (burst ? 1.4 : 1);
    for (const lag of [0, 0.04, 0.08]) {
      const t = Math.max(0, flight - lag);
      const bx = crater.x + vx * t;
      const by = crater.y - 0.02 - vy * t + 0.6 * t * t;
      if (by > crater.y + 0.05 || Math.abs(x - bx) >= 0.5 / width || Math.abs(y - by) >= 0.5 / height) continue;
      heat = Math.max(heat, (1 - lag * 6) * (1 - flight / 2.2));
    }
  }
  // Everything recedes into the page as an oval, so no edge of the image ever shows.
  const edge = Math.hypot((x - 0.5) / 0.48, (y - 0.54) / 0.52);
  const fade = 1 - smoothstep(0.62, 0.98, edge + (noise(x * 7, y * 7) - 0.5) * 0.12);
  return { tone: tone * fade, heat: heat * fade };
}

/** One frame as RGB, dithered against the repeating Bayer threshold. */
export function frame(time: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1)
    for (let column = 0; column < width; column += 1) {
      const { tone, heat } = field((column + 0.5) / width, (row + 0.5) / height, time);
      const threshold = (bayer[row % 4]![column % 4]! + 0.5) / 16;
      const scaled = clamp(tone) * (greys.length - 1);
      const base = Math.floor(scaled);
      let color: readonly number[] = greys[Math.min(greys.length - 1, base + (scaled - base > threshold ? 1 : 0))]!;
      // Heat takes the ember accent: deep where it is cooling, bright where it is hottest.
      if (heat > 0.2) {
        const level = clamp((heat - 0.2) / 0.8) * embers.length;
        const pick = Math.floor(level) + (fract(level) > threshold ? 1 : 0);
        if (pick > 0) color = embers[Math.min(embers.length, pick) - 1]!;
      }
      pixels.set(color, (row * width + column) * 3);
    }
  return pixels;
}

const chunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

/** An 8-bit RGB PNG, one frame by default. */
export function png(pixels: Uint8Array, columns = width, rows = height): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(columns, 0);
  header.writeUInt32BE(rows, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = columns * 3;
  const raw = Buffer.alloc(rows * (stride + 1));
  for (let row = 0; row < rows; row += 1)
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** Frames from `start` for `seconds`, as one animated WebP that plays `loop` times (0: forever). */
function animate(name: string, start: number, seconds: number, loop: number) {
  const work = mkdtempSync(join(tmpdir(), "site-volcano-"));
  const files = Array.from({ length: Math.round(seconds / step) }, (_, index) => {
    const file = join(work, `${String(index).padStart(3, "0")}.png`);
    writeFileSync(file, png(frame(start + index * step)));
    return file;
  });
  const output = new URL(`../public/brand/hero/${name}`, import.meta.url).pathname;
  try {
    run("img2webp", ["-loop", String(loop), "-lossless", "-d", String(Math.round(step * 1000)), ...files, "-o", output]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The share card: one still, 4× per cell, centred on page black at 1200×630. */
function card(still: Uint8Array): Buffer {
  const [columns, rows, scale] = [1200, 630, 4];
  const pixels = new Uint8Array(columns * rows * 3);
  for (let i = 0; i < columns * rows; i += 1) pixels.set(greys[0], i * 3);
  const [left, top] = [(columns - width * scale) / 2, (rows - height * scale) / 2];
  for (let y = 0; y < height * scale; y += 1)
    for (let x = 0; x < width * scale; x += 1) {
      const from = (Math.floor(y / scale) * width + Math.floor(x / scale)) * 3;
      pixels.set(still.subarray(from, from + 3), ((top + y) * columns + left + x) * 3);
    }
  return png(pixels, columns, rows);
}

if (import.meta.main) {
  animate("volcano-intro.webp", 0, introSeconds, 1);
  animate("volcano-loop.webp", introSeconds, loopSeconds, 0);
  const still = frame(introSeconds + 1.2);
  writeFileSync(new URL("../public/brand/hero/volcano.png", import.meta.url), png(still));
  writeFileSync(new URL("../public/brand/hero/card.png", import.meta.url), card(still));
}
