/**
 * Renders the home page's erupting volcano as an ordered-dither loop: a 4×4 Bayer matrix over a
 * smooth field, mapped to four tones of the site's palette at one pixel per cell. The page scales
 * it up with crisp edges. Writes an animated WebP and a still PNG for reduced motion.
 *
 *   node scripts/site-volcano.ts   (needs img2webp from libwebp)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

export const width = 112;
export const height = 128;
const frames = 48;
const frameMs = 90;
/** Near-black page, charcoal, warm grey and bone: the site's own tones. */
const palette = [
  [0x09, 0x09, 0x0b],
  [0x2a, 0x2a, 0x2d],
  [0x7d, 0x7c, 0x78],
  [0xec, 0xeb, 0xe6],
] as const;
const bayer = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const fract = (value: number) => value - Math.floor(value);
const smooth = (value: number) => value * value * (3 - 2 * value);
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

/** Low-octave value noise, so the field reads as mass rather than grain. */
function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const top = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * fx;
  const bottom = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * fx;
  return top + (bottom - top) * fy;
}

const crater = { x: 0.5, y: 0.58 };

/** The cone's half-width at a height below the crater, with slightly concave slopes. */
const slope = (y: number) => 0.06 + Math.pow(Math.max(0, y - crater.y) / (1 - crater.y), 0.85) * 0.5;

/** Brightness 0..1 at a point, for loop time t in [0, 1). */
export function field(x: number, y: number, t: number): number {
  let value = 0;
  // The cone: lit from the left, ridged, darkening toward its base.
  const half = slope(y);
  const across = (x - crater.x) / half;
  if (y >= crater.y && Math.abs(across) <= 1) {
    const ridges = noise(x * 18, y * 6) * 0.12;
    const light = 0.36 - across * 0.16 + ridges - (y - crater.y) * 0.3;
    value = Math.max(value, light);
    // Lava runs down from the rim and flickers along its course.
    for (const [side, bend] of [[-0.45, 0.06], [0.3, -0.04], [0.05, 0.03]] as const) {
      const depth = (y - crater.y) / (1 - crater.y);
      const course = side * depth + Math.sin(depth * 9 + side * 7) * bend;
      const distance = Math.abs(across - course) * half;
      const run = Math.max(0, 1 - depth * (0.9 + Math.abs(side) * 0.6));
      const flicker = 0.8 + 0.2 * Math.sin((t * 2 + depth * 3) * Math.PI * 2);
      value = Math.max(value, Math.max(0, 1 - distance / 0.02) * run * flicker * 1.15);
    }
  }
  // The crater glows.
  const glow = Math.hypot((x - crater.x) * 1.6, (y - crater.y) * 3);
  value = Math.max(value, Math.max(0, 1 - glow / 0.13));
  // The plume: lumpy puffs born at the crater rise, swell and cool, offset in phase so the loop
  // is seamless. Ash is grey and lit from the left; only its base near the vent burns bright.
  const puffs = 12;
  let ash = 0;
  let light = 0;
  for (let index = 0; index < puffs; index += 1) {
    const phase = fract(t + index / puffs);
    const cx = crater.x + Math.sin(phase * 3 + index * 1.7) * 0.05 * phase + phase * 0.05;
    const cy = crater.y - 0.04 - Math.pow(phase, 0.8) * 0.5;
    const radius = 0.035 + Math.pow(phase, 0.9) * 0.2;
    for (let lobe = 0; lobe < 3; lobe += 1) {
      const angle = index * 2.4 + lobe * 2.1;
      const lx = cx + Math.cos(angle) * radius * 0.45;
      const ly = cy + Math.sin(angle) * radius * 0.3;
      const distance = Math.hypot(x - lx, (y - ly) * 1.1) / (radius * 0.75);
      if (distance >= 1) continue;
      const density = (1 - distance * distance) * Math.pow(1 - phase, 0.6);
      ash += density;
      // Each lobe catches light on its upper left.
      light += density * Math.max(0, ((lx - x) * 0.8 + (ly - y) * 0.6) / radius);
    }
  }
  if (ash > 0) {
    const billow = noise(x * 16, y * 16 - t * 8) * 0.6 + noise(x * 34, y * 34) * 0.4;
    const cover = 1 - Math.exp(-ash * 1.8);
    value = Math.max(value, cover * (0.12 + billow * 0.42) + Math.min(0.5, light * 0.75));
  }
  // A lava fountain stands over the vent, its height pulsing through the loop.
  const rise = crater.y - y;
  const fountain = 0.13 + 0.05 * Math.sin(t * Math.PI * 4);
  if (rise > -0.01 && rise < fountain) {
    const spread = 0.012 + rise * 0.3;
    const core = Math.max(0, 1 - Math.abs(x - crater.x) / spread);
    value = Math.max(value, Math.min(1, core * 1.6) * (1.15 - rise / fountain) * (0.75 + 0.25 * noise(x * 60, y * 60 + t * 20)));
  }
  // Bombs arc out of the crater as single bright cells with a short trail.
  const bombs = 22;
  for (let index = 0; index < bombs; index += 1) {
    const speed = 1 + (index % 2);
    const phase = fract(t * speed + index / bombs);
    const vx = (hash(index, 3) - 0.5) * 0.9;
    const vy = 0.7 + hash(index, 7) * 0.6;
    for (const lag of [0, 0.035]) {
      const p = Math.max(0, phase - lag);
      const bx = crater.x + vx * p;
      const by = crater.y - 0.02 - vy * p + 1.25 * p * p;
      if (Math.abs(x - bx) < 0.5 / width && Math.abs(y - by) < 0.5 / height && by < 1)
        value = Math.max(value, (lag === 0 ? 1 : 0.6) * (1 - phase * 0.6));
    }
  }
  // A soft vignette lets the edges recede into the page, as an oval.
  const edge = Math.hypot((x - 0.5) / 0.52, (y - 0.5) / 0.6);
  return value * Math.max(0, Math.min(1, (1.1 - edge) / 0.3));
}

/** One frame as palette indices, dithered against the repeating Bayer threshold. */
export function frame(t: number): Uint8Array {
  const cells = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1)
    for (let column = 0; column < width; column += 1) {
      const scaled = Math.min(1, Math.max(0, field((column + 0.5) / width, (row + 0.5) / height, t))) * (palette.length - 1);
      const base = Math.floor(scaled);
      const threshold = (bayer[row % 4]![column % 4]! + 0.5) / 16;
      cells[row * width + column] = Math.min(palette.length - 1, base + (scaled - base > threshold ? 1 : 0));
    }
  return cells;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

/** An 8-bit RGB PNG of one frame. */
export function png(cells: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let row = 0; row < height; row += 1)
    for (let column = 0; column < width; column += 1)
      raw.set(palette[cells[row * width + column]!]!, row * (width * 3 + 1) + 1 + column * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

if (import.meta.main) {
  const output = new URL("../public/brand/hero/", import.meta.url);
  const work = mkdtempSync(join(tmpdir(), "site-volcano-"));
  const files = Array.from({ length: frames }, (_, index) => {
    const file = join(work, `${String(index).padStart(2, "0")}.png`);
    writeFileSync(file, png(frame(index / frames)));
    return file;
  });
  // The still is the eruption at full plume.
  writeFileSync(new URL("volcano.png", output), png(frame(0.35)));
  const encoded = spawnSync(
    "img2webp",
    ["-loop", "0", "-lossless", "-d", String(frameMs), ...files, "-o", new URL("volcano.webp", output).pathname],
    { stdio: "inherit" },
  );
  if (encoded.status !== 0) throw new Error("img2webp failed");
}
