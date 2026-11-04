import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import { vercelSource } from "./vercel.ts";

test("the Vercel catalog source works without its publisher", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/vercel.json"),
    async () => {
      throw new Error("The carried package is local");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), vercelSource);
  const head = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/vercel.json", { method: "HEAD" }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("Vercel offers sign-in beside its token method and keeps the gateway separate", async () => {
  const token = { method: "apiKey", kind: "secrets", label: "Access token" };
  const entry = (id: string) => ({
    id,
    package: `@executor.sh/${id}`,
    name: id,
    description: "Fixture service.",
    auth: [token],
    icons: [],
    source: `apps/${id}.json`,
  });
  const gateway = entry("vercel-ai-gateway");
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [entry("vercel"), gateway] }),
  );
  const feed = await response.json();
  const vercel = feed.apps.find((app: { id: string }) => app.id === "vercel");
  assert.deepEqual(vercel.auth, [
    { method: "oauth", kind: "oauth2", label: "Sign in with Vercel" },
    token,
  ]);
  assert.deepEqual(vercel.service.mcp, ["https://mcp.vercel.com/"]);
  const separate = feed.apps.find((app: { id: string }) => app.id === gateway.id);
  assert.deepEqual(separate.auth, gateway.auth);
  assert.notEqual(vercel.service.id, separate.service.id);
});

test("the carried source preserves the original token provider and freezes its provenance", () => {
  const bytes = (name: string) => readFileSync(new URL(`./vercel.${name}`, import.meta.url));
  const provenance = JSON.parse(bytes("provenance.json").toString());
  const original = JSON.parse(bytes("published.json").toString());
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(bytes("published.json")), provenance.publishedSha256);
  assert.equal(digest(bytes("json")), provenance.carriedSha256);
  assert.equal(digest(bytes("patch")), provenance.patchSha256);
  const index = (source: typeof vercelSource) =>
    source.files.find((file) => file.path === "index.ts")!.content;
  const provider = (source: string) =>
    source.slice(source.indexOf("const vercel ="), source.indexOf("export default defineApp"));
  assert.equal(provider(index(vercelSource)), provider(index(original)));
  assert.ok(index(vercelSource).includes("vercel: vercel.many()"));
  for (const file of original.files.filter(
    (file: { path: string }) => !["index.ts", "package.json"].includes(file.path),
  ))
    assert.equal(
      vercelSource.files.find((candidate) => candidate.path === file.path)?.content,
      file.content,
    );
});
