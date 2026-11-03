import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { Feed, FeedEntry } from "./feed.ts";
import { descriptionProblems, iconProblems } from "./listing-quality.ts";
import { recipeAdditions } from "./recipes/index.ts";
import { catalog } from "./settings.ts";
import { handleCatalog } from "./worker.ts";

const origin = "https://app.signalbox.run";
const officialText = "Official description.";
const officialIcon = "icons/official.svg";
// Every official app a catalog module branches on, so a new override is checked without editing this test,
// plus one the worker leaves alone.
const overridden = readdirSync(new URL(".", import.meta.url)).filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .flatMap(file => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/entry\.id [!=]== "([\w-]+)"/g)].map(match => match[1]!));
const official: Feed = {
  version: 1,
  apps: [...new Set([...overridden, "gmail"])]
    .map(id => ({ id, package: `@executor.sh/${id}`, name: id, description: officialText, auth: [],
      icons: [{ src: officialIcon }], source: `apps/${id}.json` })),
};

test("every listing Basalt writes has a logo that fills its tile and one plain sentence", async () => {
  const response = await handleCatalog(new Request(`${origin}/catalog/index.json`), async () => Response.json(official));
  assert.equal(response.status, 200);
  const { apps } = await response.json() as Feed;
  const upstream = new Map(official.apps.map(entry => [entry.id, entry]));
  // Recipes are Basalt's own workflows, not a vendor's service; they keep the host's app glyph.
  const recipes = new Set(recipeAdditions(origin).map(addition => addition.entry.id));
  const problems = apps.flatMap((entry: FeedEntry) => {
    const theirs = upstream.get(entry.id);
    const ownText = !theirs || entry.description !== officialText;
    const ownIcons = !recipes.has(entry.id) &&
      (!theirs || entry.icons.some(icon => icon.src !== new URL(officialIcon, catalog.official).href));
    return [...(ownText ? descriptionProblems(entry.description) : []), ...(ownIcons ? iconProblems(entry.icons) : [])]
      .map(problem => `${entry.id}: ${problem}`);
  });
  assert.deepEqual(problems, []);
  assert.ok(apps.some(entry => entry.id === "zendesk"), "the check reached Basalt's additions");
  assert.ok(["gitlab", "miro"].every(id => overridden.includes(id)), "the check reached the worker's overrides");
});

test("a padded logo and an API description are what the check reports", () => {
  const padded = png(128, 128, (x, y) => x >= 49 && x < 79 && y >= 49 && y < 79 ? [0, 0, 0, 255] : [0, 0, 0, 0]);
  assert.deepEqual(iconProblems([{ src: padded, theme: "light" }]), [
    "logo is badly cropped: its mark spans 23% of the image",
    "logo is mostly transparent: it draws 5% of its tile",
    "logo barely shows on the dark theme: 0% of it reaches 3:1 contrast",
  ]);
  const black = png(64, 64, () => [0, 0, 0, 255]);
  const white = png(64, 64, () => [255, 255, 255, 255]);
  assert.deepEqual(iconProblems([{ src: black, theme: "light" }, { src: white, theme: "dark" }]), []);
  assert.deepEqual(iconProblems([{ src: "https://example.com/favicon.ico" }]),
    ["logo must be an inline PNG data URL so its crop can be checked"]);
  assert.deepEqual(iconProblems([]), ["has no logo"]);

  const shipped = "Zendesk Support API v2 reads and writes for the connected user; every mutation requires approval.";
  assert.deepEqual(descriptionProblems(shipped).map(problem => problem.split(":")[0]), [
    "description must be one plain sentence ending in a full stop",
    'description uses jargon "API"',
    'description carries a notice ("approval"); say what the person can do instead',
  ]);
  assert.match(descriptionProblems("Editable checks. Schedules start paused.")[0]!, /one plain sentence/);
  for (const plain of [
    "Read, search, send and organize Gmail messages, threads, drafts and labels.",
    "Plan the rest of your week, e.g. focus time and breaks.",
    "Approve expenses and collect required receipts in Ramp.",
  ]) assert.deepEqual(descriptionProblems(plain), [], plain);
  for (const notice of [
    "Every change to Zendesk tickets waits for your approval.",
    "Tickets and users, available on Enterprise plans only.",
    "Everything in the Zendesk Support OpenAPI document.",
  ]) assert.notDeepEqual(descriptionProblems(notice), [], notice);
});

/** An 8-bit RGBA PNG data URL drawn by `pixel`. */
function png(width: number, height: number, pixel: (x: number, y: number) => number[]): string {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const check = Buffer.alloc(4); check.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
