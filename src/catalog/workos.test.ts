import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import { onServedFramework } from "./framework.ts";
import { workosSource } from "./workos.ts";

test("WorkOS source remains available when its publisher is unavailable", async () => {
  const request = new Request("https://catalog.example.test/catalog/apps/workos.json");
  const response = await handleCatalog(request, async () => {
    throw new Error("Publisher unavailable");
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(workosSource))),
  );
  const head = await handleCatalog(new Request(request, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("WorkOS guides bind exact requirements while unrelated catalog entries keep their methods", async () => {
  const key = { method: "apiKey", kind: "secrets", label: "API key" };
  const entry = (id: string) => ({
    id,
    package: `@executor.sh/${id}`,
    name: id,
    description: "Fixture service.",
    auth: [key],
    icons: [],
    source: `apps/${id}.json`,
  });
  const unrelated = entry("example-vendor");
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [entry("workos"), unrelated] }),
  );
  const feed = await response.json();
  const workos = feed.apps.find((item: { id: string }) => item.id === "workos");
  assert.deepEqual(workos.auth, [
    { method: "oauth", kind: "oauth2", label: "Sign in with WorkOS" },
    key,
  ]);
  const guides = workos.connectionGuidance;
  assert.deepEqual(
    guides.map((guide: { requirement: string; method: string }) => [
      guide.requirement,
      guide.method,
    ]),
    [
      ["signIn", "oauth"],
      ["workos", "apiKey"],
    ],
  );
  assert.equal(guides[1].credentials.link.url, "https://dashboard.workos.com/api-keys");
  assert.equal(guides[1].credentials.fields.token.label, "API key");
  const unchanged = feed.apps.find((item: { id: string }) => item.id === unrelated.id);
  assert.deepEqual(unchanged.auth, unrelated.auth);
  assert.equal(unchanged.connectionGuidance, undefined);
});

test("WorkOS refuses a publisher package change instead of attaching guidance to another app", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () =>
      Response.json({
        version: 1,
        apps: [
          {
            id: "workos",
            package: "@other/workos",
            name: "WorkOS",
            description: "Fixture.",
            auth: [],
            icons: [],
            source: "apps/workos.json",
          },
        ],
      }),
  );
  assert.equal(response.status, 502);
});

test("WorkOS preserves the original key provider and freezes reviewed source provenance", () => {
  const bytes = (extension: string) =>
    readFileSync(new URL(`./workos.${extension}`, import.meta.url));
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const provenance = JSON.parse(bytes("provenance.json").toString());
  assert.equal(digest(bytes("published.json")), provenance.publishedSha256);
  assert.equal(digest(bytes("json")), provenance.carriedSha256);
  assert.equal(digest(bytes("patch")), provenance.patchSha256);
  const original = JSON.parse(bytes("published.json").toString());
  const index = (source: typeof workosSource) =>
    source.files.find((file) => file.path === "index.ts")!.content;
  const provider = (content: string) =>
    content.slice(content.indexOf("const workos ="), content.indexOf("export default defineApp"));
  assert.equal(provider(index(workosSource)), provider(index(original)));
  for (const path of ["openapi.ts", "icon.ts"]) {
    assert.equal(
      workosSource.files.find((file) => file.path === path)?.content,
      original.files.find((file: { path: string }) => file.path === path)?.content,
    );
  }
});
