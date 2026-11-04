import { onServedFramework } from "./framework.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import { elevenlabsSource } from "./elevenlabs.ts";

test("the ElevenLabs catalog source works without its publisher", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/elevenlabs.json"),
    async () => {
      throw new Error("The carried package is local");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(elevenlabsSource))),
  );
  const head = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/elevenlabs.json", { method: "HEAD" }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("the carried source preserves the original token provider and freezes its provenance", () => {
  const bytes = (name: string) => readFileSync(new URL(`./elevenlabs.${name}`, import.meta.url));
  const provenance = JSON.parse(bytes("provenance.json").toString());
  const original = JSON.parse(bytes("published.json").toString());
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(bytes("published.json")), provenance.publishedSha256);
  assert.equal(digest(bytes("json")), provenance.carriedSha256);
  assert.equal(digest(bytes("patch")), provenance.patchSha256);
  const index = (source: typeof elevenlabsSource) =>
    source.files.find((file) => file.path === "index.ts")!.content;
  const provider = (source: string) =>
    source.slice(source.indexOf("const elevenlabs ="), source.indexOf("export default defineApp"));
  assert.equal(provider(index(elevenlabsSource)), provider(index(original)));
  assert.ok(index(elevenlabsSource).includes("elevenlabs: elevenlabs.many()"));
  for (const file of original.files.filter(
    (file: { path: string }) => !["README.md", "index.ts", "package.json"].includes(file.path),
  ))
    assert.equal(
      elevenlabsSource.files.find((candidate) => candidate.path === file.path)?.content,
      file.content,
    );
});
