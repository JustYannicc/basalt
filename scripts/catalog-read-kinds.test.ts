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
  operations: { scrape: { method: "post", path: "/scrape", tags: null, inputSha256: hash(value) } },
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

const bodySchema = (value: ReturnType<typeof document>) =>
  value.paths["/scrape"].post.requestBody.content["application/json"].schema;
const webhook = { webhook: { type: "string" } };

test("a reference with more than wording beside it refuses, since a schema adds it to the target", () => {
  const pin = pinned(document());
  const worded = document();
  Object.assign(bodySchema(worded), { description: "The options.", title: "Options" });
  assert.deepEqual(readKindDrift("example", pin, worded), []);
  // JSON Schema 2020-12 applies a reference's siblings too, so the served body gains `webhook`.
  const sibling = document();
  Object.assign(bodySchema(sibling), { properties: webhook });
  assert.deepEqual(readKindDrift("example", pin, sibling), [
    'example/scrape: its input reference "#/components/schemas/Options" has properties beside it, which the hash would leave out',
  ]);
  assert.throws(() => hash(sibling), /^Error: post \/scrape: its input reference .* properties/);
});

test("a reference the check cannot follow refuses, rather than hash the reference itself", () => {
  const pin = pinned(document());
  // The framework decodes percent-encoding: this names Options, which gains `webhook`.
  const encoded = document();
  bodySchema(encoded).$ref = "#/components/schemas/Opti%6Fns";
  Object.assign(encoded.components.schemas.Options.properties, webhook);
  // It also indexes arrays, for a schema and for a request body.
  const indexed = document();
  bodySchema(indexed).$ref = "#/x-schemas/0";
  const options = indexed.components.schemas.Options;
  Object.assign(indexed, {
    "x-schemas": [{ ...options, properties: { ...options.properties, ...webhook } }],
  });
  const body = document();
  const content = body.paths["/scrape"].post.requestBody.content;
  Object.assign(body.paths["/scrape"].post, { requestBody: { $ref: "#/x-bodies/0" } });
  Object.assign(body, { "x-bodies": [{ content }] });
  Object.assign(body.components.schemas.Options.properties, webhook);
  // It resolves Scrape to Other before following the pointer, keeping only wording beside it, so
  // it serves Other's schema while a walk of the document as written reads the copy.
  const through = document();
  bodySchema(through).$ref = "#/components/requestBodies/Scrape/content/application~1json/schema";
  Object.assign(through.components, {
    requestBodies: {
      Scrape: {
        $ref: "#/components/requestBodies/Other",
        content: { "application/json": { schema: { $ref: "#/components/schemas/Options" } } },
      },
      Other: {
        content: { "application/json": { schema: { type: "object", properties: webhook } } },
      },
    },
  });
  // An inherited key is no part of the document.
  const inherited = document();
  bodySchema(inherited).$ref = "#/components/schemas/constructor";
  for (const [value, reference] of [
    [encoded, "#/components/schemas/Opti%6Fns"],
    [indexed, "#/x-schemas/0"],
    [body, "#/x-bodies/0"],
    [through, "#/components/requestBodies/Scrape/content/application~1json/schema"],
    [inherited, "#/components/schemas/constructor"],
  ] as const) {
    assert.deepEqual(readKindDrift("example", pin, value), [
      `example/scrape: its input reference ${JSON.stringify(reference)} cannot be followed by the check, so the hash would not cover its target`,
    ]);
    assert.throws(() => hash(value), /^Error: post \/scrape: .* cannot be followed/, reference);
  }
});

test("a server the hash cannot stand for refuses: variables, servers not in a list, not OpenAPI 3", () => {
  const pin = pinned(document());
  // The framework fills a variable from its default, which the hash drops when it is named like
  // wording, and a path item's server takes undeclared variables from the document's server.
  const wordlike = document();
  Object.assign(wordlike, {
    servers: [
      {
        url: "https://api.example.test/{description}",
        variables: { description: { default: "v2" } },
      },
    ],
  });
  const inherited = document();
  Object.assign(inherited, {
    servers: [{ url: "https://api.example.test", variables: { v: { default: "v2" } } }],
  });
  Object.assign(inherited.paths["/scrape"], { servers: [{ url: "https://api.example.test/{v}" }] });
  // The framework skips path item servers that are not a list and uses the document's.
  const unlisted = document();
  Object.assign(unlisted.paths["/scrape"], { servers: {} });
  // Swagger 2.0 builds the address from host, basePath and schemes instead.
  const swagger = document();
  Reflect.deleteProperty(swagger, "openapi");
  Object.assign(swagger, { swagger: "2.0", host: "api.example.test", basePath: "/v2" });
  for (const [value, reason] of [
    [wordlike, 'its server "https://api.example.test/{description}" has variables'],
    [inherited, 'its server "https://api.example.test/{v}" has variables'],
    [unlisted, "its path item servers are not a list"],
    [swagger, "its document is not OpenAPI 3.x"],
  ] as const) {
    assert.deepEqual(readKindDrift("example", pin, value), [
      `example/scrape: ${reason}, so the hash would not cover the address it is sent to`,
    ]);
    assert.throws(() => hash(value), /^Error: post \/scrape: its /, reason);
  }
});

test("a reviewed read's tags are pinned, since they name its tool", () => {
  // A tag that reads like the operationId drops the id from the tool's name, and Firecrawl's
  // approval policy recognises its reads by that name.
  const pin = pinned(document());
  const tagged = document();
  Object.assign(tagged.paths["/scrape"].post, { tags: ["Scrape"] });
  assert.deepEqual(readKindDrift("example", pin, tagged), [
    'example/scrape: tags null → ["Scrape"]',
  ]);
});

test("every pin reads the document its package serves", () => {
  const packages = new Map(catalogPackages().map(({ app, code }) => [app, code]));
  for (const [app, pin] of Object.entries(pins))
    assert.ok(
      packages.get(app)?.some((content) => content.includes(`url: ${JSON.stringify(pin.source)}`)),
      `${app} does not serve ${pin.source}`,
    );
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
