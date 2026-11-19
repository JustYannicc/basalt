import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

/** Every package the catalog serves, named like its pins: `<app>.json` or `<app>/source.json`. */
const catalogPackages = () =>
  readdirSync(new URL("../src/catalog/", import.meta.url), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".json") && !path.endsWith(".published.json"))
    .flatMap((path) => {
      const source = read(`../src/catalog/${path}`);
      if (!Array.isArray(source?.files)) return [];
      const app = path.replace(/(\/source)?\.json$/, "");
      const code = (source.files as { path: string; content: unknown }[]).filter(
        (file) => /\.[mc]?[jt]s$/.test(file.path) && typeof file.content === "string",
      );
      return [{ app, code: code.map((file) => file.content as string) }];
    });
// A package reclassifies when it sets OpenAPI `kinds` and one of its operations to a read. That
// over-matches (an API key sent `in: "query"` counts), which only asks for a recorded reason.
const reclassifies = (code: readonly string[]) =>
  code.some((content) => /\bkinds\b\s*[:,}=]/.test(content)) &&
  code.some((content) => /["'`]query["'`]/.test(content));

/**
 * Packages that reclassify reads without pins, and why. The pins guard a live document that can
 * change under a reviewed read; every other package that reclassifies needs pins.
 */
const unpinned: Readonly<Record<string, string>> = {
  atlassian: "Its loader compiles a specification only when its reviewed sha256 matches.",
  google:
    "Photos compiles a bundled document. Sheets compiles a live document; its reads are not pinned yet.",
  "google-maps": "It compiles only documents bundled in the package.",
  notion: "Its document URL is pinned to a commit.",
  plaid: "It compiles a live document; its reads are not pinned yet.",
};

test("every catalog package that reclassifies operations as reads is pinned or has a reason", () => {
  const found = catalogPackages()
    .filter(({ code }) => reclassifies(code))
    .map(({ app }) => app)
    .sort();
  const missing = found.filter((app) => pins[app] === undefined && unpinned[app] === undefined);
  assert.deepEqual(missing, [], "these packages reclassify reads with no pins and no reason");
  const stale = [...Object.keys(pins), ...Object.keys(unpinned)].filter(
    (app) => !found.includes(app),
  );
  assert.deepEqual(stale, [], "these pinned or excused packages no longer reclassify reads");
  const both = Object.keys(pins).filter((app) => unpinned[app] !== undefined);
  assert.deepEqual(both, [], "these packages are both pinned and excused");
});

test("every pinned app's pins are exactly the operations it reclassifies as reads", () => {
  for (const app of Object.keys(pins)) {
    const kinds: Record<string, string> = read(`../src/catalog/tests/${app}-kinds.json`);
    const document = read(`../src/catalog/tests/${app}-openapi.json`);
    const reclassified = Object.entries(kinds)
      .filter(([operationId, kind]) => {
        const found = findOperation(document, operationId);
        return kind !== "mutation" && !(found !== undefined && safe.has(found.method));
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

test("an operationId declared more than once refuses, wherever the copy is listed", () => {
  const original = document();
  const pin = pinned(original);
  const refusal = (where: string) =>
    `example/scrape: 2 operations declare this operationId (${where}), so its read kind would cover each of them`;
  // The framework keys kinds by operationId and renames the copy's tool (scrapeAndExtractFromUrl
  // on POST /scrape/execute becomes scrapeAndExtractFromUrlExecute), so the copy would be a read.
  const after = document();
  Object.assign(after.paths, { "/scrape/execute": { post: after.paths["/scrape"].post } });
  assert.deepEqual(readKindDrift("example", pin, after), [
    refusal("post /scrape, post /scrape/execute"),
  ]);
  const before = document();
  const scrape = before.paths["/scrape"];
  Reflect.deleteProperty(before.paths, "/scrape");
  Object.assign(before.paths, { "/scrape/execute": { post: scrape.post }, "/scrape": scrape });
  assert.deepEqual(readKindDrift("example", pin, before), [
    refusal("post /scrape/execute, post /scrape"),
  ]);
  // The framework resolves path items and operations written as references, keeping a path
  // item's siblings, so a copy can hide behind one; the check refuses every such reference.
  const referenced = document();
  Object.assign(referenced.paths, { "/scrape/execute": { $ref: "#/paths/~1scrape" } });
  const reference = (slot: string) =>
    `example: ${slot} is a reference; the check reads operations only where written`;
  assert.deepEqual(readKindDrift("example", pin, referenced), [
    reference("path item /scrape/execute"),
  ]);
  const sibling = document();
  Object.assign(sibling.paths, {
    "/map/execute": { $ref: "#/paths/~1map", post: sibling.paths["/scrape"].post },
  });
  assert.deepEqual(readKindDrift("example", pin, sibling), [
    reference("path item /map/execute"),
    refusal("post /scrape, post /map/execute"),
  ]);
  const operation = document();
  Object.assign(operation.paths, {
    "/scrape/execute": { put: { $ref: "#/paths/~1scrape/post" } },
    "/scrape/run": { additionalOperations: { $ref: "#/components/operations" } },
  });
  assert.deepEqual(readKindDrift("example", pin, operation), [
    reference("put /scrape/execute"),
    reference("additionalOperations of /scrape/run"),
  ]);
  // Another method on the same path counts as well.
  const deleted = document();
  Object.assign(deleted.paths["/scrape"], { delete: deleted.paths["/scrape"].post });
  assert.deepEqual(readKindDrift("example", pin, deleted), [
    refusal("post /scrape, delete /scrape"),
  ]);
});

test("a missing operationId refuses with the operation it left", () => {
  const pin = pinned(document());
  const absent = document();
  Reflect.deleteProperty(absent.paths["/scrape"].post, "operationId");
  // YAML writes an empty `operationId:` as null, which the framework reads as absent.
  const empty = document();
  Object.assign(empty.paths["/scrape"].post, { operationId: null });
  for (const value of [absent, empty])
    assert.deepEqual(readKindDrift("example", pin, value), [
      "example/scrape: post /scrape no longer declares an operationId",
    ]);
});

test("a malformed operationId refuses, on the pinned operation or any other", () => {
  const pin = pinned(document());
  const pinnedNumber = document();
  Object.assign(pinnedNumber.paths["/scrape"].post, { operationId: 42 });
  assert.deepEqual(readKindDrift("example", pin, pinnedNumber), [
    "example: post /scrape declares a non-string operationId, 42",
    "example/scrape: post /scrape no longer declares this operationId",
  ]);
  // An array whose only item is a pinned id would name it once coerced to a property key.
  const other = document();
  Object.assign(other.paths, {
    "/scrape/execute": { post: { ...other.paths["/scrape"].post, operationId: ["scrape"] } },
  });
  assert.deepEqual(readKindDrift("example", pin, other), [
    'example: post /scrape/execute declares a non-string operationId, ["scrape"]',
  ]);
});
