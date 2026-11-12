import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const fields = ["input", "output", "cache_read", "cache_write", "request"] as const;
const aliases = [
  ["input", "input_price", "inputPrice"],
  ["output", "output_price", "outputPrice"],
  ["cache_read", "cacheRead", "cache_read_price"],
  ["cache_write", "cacheWrite", "cache_write_price"],
  ["request", "request_price", "requestPrice"],
];
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const number = (v: unknown) => {
  if ((typeof v !== "number" && typeof v !== "string") || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : undefined;
};
const decimal = (v: number) => v.toFixed(12).replace(/\.?0+$/, "") || "0";

function cost(raw: unknown) {
  const r = record(raw);
  if (!r) return undefined;
  for (const key of [
    "image",
    "input_image",
    "output_image",
    "audio",
    "input_audio",
    "output_audio",
    "video",
    "reasoning",
  ])
    if (r[key] !== undefined && r[key] !== null && number(r[key]) !== 0) return undefined;
  const values = aliases.map((keys) => {
    const key = keys.find((k) => r[k] !== undefined && r[k] !== null);
    return key === undefined ? undefined : number(r[key]);
  });
  if (
    aliases.some(
      (keys, i) => keys.some((k) => r[k] !== undefined && r[k] !== null) && values[i] === undefined,
    )
  )
    return undefined;
  if (values.every((v) => v === undefined)) return undefined;
  // Home's public importer supplies these cache defaults only when an input rate exists.
  if (values[0] !== undefined) {
    values[2] ??= values[0] * 0.1;
    values[3] ??= values[0] * 1.25;
  }
  if (values.some((v) => v !== undefined && v > 0 && Number(decimal(v)) === 0)) return undefined;
  return {
    values: values.map((v) => decimal(v ?? 0)),
    present: values.map((v) => v !== undefined),
  };
}

/** Compact models.dev's public rates, preserving Home's complete-model/context-band policy. */
export function publicPriceSnapshot(raw: string, asOf: string) {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("A source capture date is required");
  const root = record(JSON.parse(raw));
  if (!root) throw new Error("Invalid models.dev catalog");
  const models: Record<string, Record<string, string[][] | null>> = {};
  for (const [provider, value] of Object.entries(root).sort()) {
    const entries = record(record(value)?.models);
    if (!entries) continue;
    const output: Record<string, string[][] | null> = {};
    for (const [key, item] of Object.entries(entries).sort()) {
      const model = record(item);
      if (!model) continue;
      const id = typeof model.id === "string" && model.id.trim() ? model.id.trim() : key;
      const rawCost = record(model.cost ?? model.pricing);
      const base = cost(rawCost);
      output[id] = rawCost && Object.keys(rawCost).length ? null : [];
      if (!rawCost || !base) continue;
      const bands: string[][] = [["0", ...base.values]];
      const tiers: { min: number; raw: unknown }[] = [];
      let invalid = false;
      if (Array.isArray(rawCost.tiers)) {
        for (const value of rawCost.tiers) {
          const metadata = record(record(value)?.tier);
          const size = number(metadata?.size);
          if (metadata?.type !== "context" || size === undefined || !Number.isSafeInteger(size)) {
            invalid = true;
            break;
          }
          tiers.push({ min: size + 1, raw: value });
        }
      } else if (record(rawCost.tiers)) {
        for (const [boundary, value] of Object.entries(record(rawCost.tiers)!)) {
          const size = number(boundary);
          if (size === undefined || !Number.isSafeInteger(size)) {
            invalid = true;
            break;
          }
          const nested = record(value);
          tiers.push({ min: size + 1, raw: nested?.cost ?? nested?.pricing ?? value });
        }
      } else if (rawCost.tiers !== undefined && rawCost.tiers !== null) invalid = true;
      if (!tiers.length && !invalid && rawCost.context_over_200k !== undefined)
        tiers.push({ min: 200001, raw: rawCost.context_over_200k });
      const seen = new Set([0]);
      for (const tier of tiers) {
        const prices = cost(tier.raw);
        if (
          !prices ||
          seen.has(tier.min) ||
          !Number.isSafeInteger(tier.min) ||
          base.present.some((v, i) => v && !prices.present[i])
        ) {
          invalid = true;
          break;
        }
        seen.add(tier.min);
        bands.push([String(tier.min), ...prices.values]);
      }
      if (!invalid) output[id] = bands.sort((a, b) => Number(a[0]) - Number(b[0]));
    }
    models[provider] = output;
  }
  if (!Object.values(models).some((v) => Object.values(v).some(Boolean)))
    throw new Error("No usable public rates");
  return {
    source: "models.dev",
    url: "https://models.dev/api.json",
    license: "MIT",
    asOf,
    version: createHash("sha256").update(raw).digest("hex"),
    fields: ["minInput", ...fields],
    models,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [path, asOf] = process.argv.slice(2);
  if (!path || !asOf)
    throw new Error(
      "Usage: node scripts/public-price-baseline.ts <captured-models.dev.json> <capture-ISO-date>",
    );
  const snapshot = publicPriceSnapshot(readFileSync(path, "utf8"), asOf);
  writeFileSync(
    new URL("../src/pool/public-price-baseline.json", import.meta.url),
    JSON.stringify(snapshot) + "\n",
  );
  console.log(`Saved public price snapshot ${snapshot.asOf} ${snapshot.version}`);
}
