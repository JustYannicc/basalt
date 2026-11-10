import { onServedFramework } from "./framework.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import { neonSource } from "./neon.ts";

const bytes = (name: string) => readFileSync(new URL(`./neon.${name}`, import.meta.url));
const original: typeof neonSource = JSON.parse(bytes("published.json").toString());
const index = (source: typeof neonSource) =>
  source.files.find((file) => file.path === "index.ts")!.content;
/** A provider declaration's name and `auth` block, which together decide its identity. */
const identity = (source: string, provider: string) => {
  const start = source.indexOf(`const ${provider} = defineProvider(`);
  const name = source.slice(source.indexOf("name: ", start), source.indexOf(",\n", start));
  const from = source.indexOf("auth: {", start);
  return [name, source.slice(from, source.indexOf("\n  },\n", from))];
};
const hosts = (source: string, provider: string) => {
  const start = source.indexOf(`const ${provider} = defineProvider(`);
  return JSON.parse(
    source.slice(source.indexOf("hosts: ", start) + 7, source.indexOf("],", start) + 1),
  );
};

test("the Neon catalog source works without its publisher", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/neon.json"),
    async () => {
      throw new Error("The carried package is local");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(neonSource))),
  );
  const head = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/neon.json", { method: "HEAD" }),
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("the carried source freezes its provenance and keeps both providers' identity", () => {
  const provenance = JSON.parse(bytes("provenance.json").toString());
  const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  assert.equal(digest(bytes("published.json")), provenance.publishedSha256);
  assert.equal(digest(bytes("json")), provenance.carriedSha256);
  assert.equal(digest(bytes("patch")), provenance.patchSha256);
  // Saved accounts keep their provider: names and auth methods are exactly as published.
  for (const provider of ["neon", "neonMcp"])
    assert.deepEqual(identity(index(neonSource), provider), identity(index(original), provider));
  assert.ok(
    index(neonSource).includes(
      "{ user: { accounts: { neon: neon.many(), neonMcp: neonMcp.many() } }, icons }",
    ),
  );
  for (const file of original.files.filter(
    (file) => !["README.md", "index.ts", "package.json"].includes(file.path),
  ))
    assert.equal(
      neonSource.files.find((candidate) => candidate.path === file.path)?.content,
      file.content,
    );
});

test("both Neon providers may send their key to both hosts, and only keys reach the REST API", () => {
  // Secrets reach only a provider's declared hosts; the e2e proves the routers use them.
  for (const provider of ["neon", "neonMcp"])
    assert.deepEqual(hosts(index(neonSource), provider).sort(), [
      "console.neon.tech",
      "mcp.neon.tech",
    ]);
  // MCP OAuth tokens may now go to the REST host too, so this filter alone keeps them off the REST
  // router; the e2e runs no OAuth sign-in.
  const api = index(neonSource).slice(index(neonSource).indexOf("api: router("));
  assert.match(
    api.slice(0, api.indexOf("withApprovals(")),
    /\.\.\.\(user\?\.accounts\.neonMcp \?\? \[\]\)\.filter\(\(account\) => account\.method === "apiKey"\)/,
  );
});
