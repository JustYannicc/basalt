import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import provenance from "../../assets/fonts/geist/provenance.json" with { type: "json" };

const root = fileURLToPath(new URL("../../", import.meta.url));
const docs = join(root, ".upstream/apps/docs");
// A cached provider response or OG image would hide a new remote dependency.
rmSync(join(docs, ".blume"), { recursive: true, force: true });
const build = spawnSync(
  process.execPath,
  [
    "--import",
    new URL("./block-network.mjs", import.meta.url).href,
    join(docs, "node_modules/blume/bin/blume.mjs"),
    "build",
  ],
  { cwd: docs, stdio: "inherit", env: process.env },
);
if (build.error) throw build.error;
assert.equal(build.status, 0, "Docs must build without Google font requests");

const html = readFileSync(join(docs, "dist/index.html"), "utf8");
const faces = [...html.matchAll(/@font-face\s*\{[^}]+\}/g)]
  .map((match) => match[0])
  .filter((face) => face.includes("url(") && face.includes("Geist"));
assert.equal(faces.length, provenance.files.length, "Every font face must remain self-hosted");
const normalizeRange = (value: string) => value.replace(/\s/g, "").toUpperCase();
const seen = new Set<string>();
for (const face of faces) {
  const url = face.match(/url\(["']?(\/docs\/_astro\/fonts\/[^)"']+)/)?.[1];
  assert(url, "Font face must reference a built local asset");
  const bytes = readFileSync(join(docs, "dist", url.slice("/docs/".length)));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const font = provenance.files.find((file) => file.sha256 === hash);
  assert(font, "Emitted font must match a licensed source asset");
  assert.equal(seen.has(font.file), false, "Each font face must be emitted once");
  seen.add(font.file);
  assert.equal(face.match(/font-weight:\s*([^;}]+)/)?.[1]?.trim(), font.weights.join(" "));
  assert.equal(face.match(/font-style:\s*([^;}]+)/)?.[1]?.trim(), font.style);
  assert.equal(
    normalizeRange(face.match(/unicode-range:\s*([^;}]+)/)?.[1] ?? ""),
    normalizeRange(provenance.css_unicode_range),
  );
  const source = readFileSync(join(root, "assets/fonts/geist", font.file));
  assert.equal(createHash("sha256").update(source).digest("hex"), hash);
}
assert.equal(seen.size, provenance.files.length);
console.log(
  `Docs built with both Google font hosts blocked; ${seen.size} matching local faces retain their styles, weights and Latin range.`,
);
