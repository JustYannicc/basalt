import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  findOperation,
  operationInputSha256,
  readKindDrift,
  type ReadKindPins,
} from "./catalog-read-kinds.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const pins: ReadKindPins = read("../src/catalog/read-kinds.json");
const safe = new Set(["get", "head", "options", "query"]);

test("every operation a carried app reclassifies as a read is pinned, and nothing else", () => {
  for (const app of ["exa", "firecrawl"]) {
    const kinds: Record<string, string> = read(`../src/catalog/tests/${app}-kinds.json`);
    const document = read(`../src/catalog/tests/${app}-openapi.json`);
    const reclassified = Object.entries(kinds)
      .filter(([operationId, kind]) => {
        const found = findOperation(document, operationId);
        return kind === "query" && found !== undefined && !safe.has(found.method);
      })
      .map(([operationId]) => operationId)
      .sort();
    assert.deepEqual(Object.keys(pins[app]!.operations).sort(), reclassified, app);
    for (const [operationId, pin] of Object.entries(pins[app]!.operations)) {
      const found = findOperation(document, operationId)!;
      assert.deepEqual([pin.method, pin.path], [found.method, found.path], `${app}/${operationId}`);
    }
  }
});

/** A small document whose one POST read takes a referenced body schema. */
const document = () => ({
  openapi: "3.1.0",
  servers: [{ url: "https://api.example.test" }],
  components: {
    schemas: {
      Options: {
        type: "object",
        description: "Scrape options.",
        properties: {
          url: { type: "string", description: "The page." },
          description: { type: "string" },
          next: { $ref: "#/components/schemas/Options" },
        },
      },
    },
  },
  paths: {
    "/scrape": {
      post: {
        operationId: "scrape",
        summary: "Scrape a page",
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Options" } } },
        },
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const hash = (value: ReturnType<typeof document>) =>
  operationInputSha256(value, findOperation(value, "scrape")!);
const pinned = (value: ReturnType<typeof document>) => ({
  source: "https://api.example.test/openapi.json",
  operations: { scrape: { method: "post", path: "/scrape", inputSha256: hash(value) } },
});

test("wording and samples leave the input hash unchanged", () => {
  const changed = document();
  changed.components.schemas.Options.description = "Different wording.";
  changed.components.schemas.Options.properties.url.description = "Another page.";
  changed.paths["/scrape"].post.summary = "Reworded";
  assert.equal(hash(changed), hash(document()));
});

test("a new option, a changed referenced schema or a renamed property changes the hash", () => {
  const added = document();
  Object.assign(added.components.schemas.Options.properties, { webhook: { type: "string" } });
  const retyped = document();
  retyped.components.schemas.Options.properties.url.type = "array";
  // A property named like a wording key is an input, not wording.
  const renamed = document();
  Reflect.deleteProperty(renamed.components.schemas.Options.properties, "description");
  const server = document();
  Object.assign(server.paths["/scrape"].post, { servers: [{ url: "https://jobs.example.test" }] });
  for (const value of [added, retyped, renamed, server])
    assert.notEqual(hash(value), hash(document()));
});

test("drift names the app, the operation and the change", () => {
  const original = document();
  const pin = pinned(original);
  assert.deepEqual(readKindDrift("example", pin, original), []);
  const added = document();
  Object.assign(added.components.schemas.Options.properties, { webhook: { type: "string" } });
  assert.deepEqual(readKindDrift("example", pin, added), [
    `example/scrape: input sha256 ${pin.operations.scrape.inputSha256} → ${hash(added)}`,
  ]);
  const moved = document();
  Object.assign(moved.paths, { "/v2/scrape": moved.paths["/scrape"] });
  Reflect.deleteProperty(moved.paths, "/scrape");
  assert.match(readKindDrift("example", pin, moved).join("\n"), /path \/scrape → \/v2\/scrape/);
  const gone = document();
  Reflect.deleteProperty(gone.paths, "/scrape");
  assert.deepEqual(readKindDrift("example", pin, gone), [
    "example/scrape: the document no longer declares this operation",
  ]);
});
