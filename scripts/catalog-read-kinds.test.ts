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
  openapi: "3.1.0",
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
  // The framework follows these where component schemas are kept apart, so it reads them empty
  // and the body accepts anything.
  const schemas = document();
  bodySchema(schemas).$ref = "#/components/schemas";
  const components = document();
  bodySchema(components).$ref = "#/components";
  for (const [value, reference] of [
    [encoded, "#/components/schemas/Opti%6Fns"],
    [indexed, "#/x-schemas/0"],
    [body, "#/x-bodies/0"],
    [through, "#/components/requestBodies/Scrape/content/application~1json/schema"],
    [inherited, "#/components/schemas/constructor"],
    [schemas, "#/components/schemas"],
    [components, "#/components"],
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
  // A `swagger` version makes the framework convert the document as Swagger 2.0, whatever its
  // `openapi` says: the address comes from host, basePath and schemes, and its schemas move.
  const swagger = document();
  Object.assign(swagger, { swagger: "2.0", host: "api.example.test", basePath: "/v2" });
  const address = "so the hash would not cover the address it is sent to";
  for (const [value, reason] of [
    [wordlike, `its server "https://api.example.test/{description}" has variables, ${address}`],
    [inherited, `its server "https://api.example.test/{v}" has variables, ${address}`],
    [unlisted, `its path item servers are not a list, ${address}`],
    [
      swagger,
      'its document is not plain OpenAPI 3.x (openapi "3.1.0", swagger "2.0"), so the hash would not cover how it is sent',
    ],
  ] as const) {
    assert.deepEqual(readKindDrift("example", pin, value), [`example/scrape: ${reason}`]);
    assert.throws(() => hash(value), /^Error: post \/scrape: its /, reason);
  }
});

test("each app pins its OpenAPI version, which picks how its schemas are read", () => {
  const pin = pinned(document());
  const older = document();
  older.openapi = "3.0.3";
  assert.deepEqual(readKindDrift("example", pin, older), ['example: openapi "3.1.0" → "3.0.3"']);
  const swagger = document();
  Reflect.deleteProperty(swagger, "openapi");
  Object.assign(swagger, { swagger: "2.0" });
  assert.deepEqual(readKindDrift("example", pin, swagger), [
    'example: openapi "3.1.0" → null',
    'example/scrape: its document is not plain OpenAPI 3.x (openapi null, swagger "2.0"), so the hash would not cover how it is sent',
  ]);
});

test("a reviewed read's tags are pinned, since they name its tool", () => {
  // A tag that reads like the operationId drops the id from the tool's name, and Firecrawl's
  // approval policy recognises its reads by that name.
  const pin = pinned(document());
  const tagged = document();
  Object.assign(tagged.paths["/scrape"].post, { tags: ["Scrape"] });
  assert.deepEqual(readKindDrift("example", pin, tagged), [
    'example/scrape: tags null → ["Scrape"]; they name its tool, so check that its approval policy still recognises it',
  ]);
  // Naming reads tags as a list; anything else drops the operationId from the name outright.
  const unlisted = document();
  Object.assign(unlisted.paths["/scrape"].post, { tags: "Scrape" });
  assert.deepEqual(readKindDrift("example", pin, unlisted), [
    "example/scrape: its tags are not a list, so the framework would name its tool without its operationId",
  ]);
});

test("a __proto__ key anywhere refuses, since the framework reads it as inherited fields", () => {
  const pin = pinned(document());
  // JSON keeps `__proto__` as a key, as here; an object literal would set the prototype instead.
  const hidden = (json: string) => {
    const value = document();
    Object.assign(value.paths, { "/crawl": JSON.parse(json) });
    return value;
  };
  for (const [value, at] of [
    [hidden('{"__proto__": {"post": {"operationId": "scrape"}}}'), "#/paths/~1crawl"],
    [hidden('{"post": {"__proto__": {"operationId": "scrape"}}}'), "#/paths/~1crawl/post"],
  ] as const)
    assert.deepEqual(readKindDrift("example", pin, value), [
      `example: ${at} has a __proto__ key, which the framework would read as inherited fields`,
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

/** A small OpenAPI 3.0 map read, like Firecrawl's: a POST whose body is a component schema. */
const mapDocument = () => ({
  openapi: "3.0.0",
  servers: [{ url: "https://api.firecrawl.dev/v2" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: {
      MapOptions: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
  },
  paths: {
    "/map": {
      post: {
        operationId: "mapUrls",
        tags: ["Mapping"],
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/MapOptions" } },
          },
        },
        responses: { 200: { description: "ok" } },
      },
    },
  },
});
const mapHash = (value: ReturnType<typeof mapDocument>) =>
  operationInputSha256(value, findOperation(value, "mapUrls")!);
const mapPin = (value: ReturnType<typeof mapDocument>) => ({
  source: "https://api.firecrawl.dev/openapi.json",
  openapi: "3.0.0",
  operations: {
    mapUrls: { method: "post", path: "/map", tags: ["Mapping"], inputSha256: mapHash(value) },
  },
});
const mapBody = (value: ReturnType<typeof mapDocument>) =>
  value.paths["/map"].post.requestBody.content;

test("a media type written as a reference refuses, since the framework serves it as written", () => {
  // The framework resolves no reference into component schemas outside a schema value, and media
  // types get no schema-style second pass, so it would serve this body as `{}`.
  const media = mapDocument();
  Object.assign(media.components.schemas, { MapMedia: mapBody(media)["application/json"] });
  Object.assign(mapBody(media), { "application/json": { $ref: "#/components/schemas/MapMedia" } });
  // Its object resolver skips the value of any key named `schema`, so a media type named so is
  // never resolved, wherever its reference points.
  const inline = mapDocument();
  const named = mapDocument();
  for (const value of [inline, named]) {
    const { "application/json": json } = mapBody(value);
    Object.assign(value.paths["/map"].post.requestBody, { content: { schema: json } });
    Object.assign(value, { "x-media": json });
  }
  Object.assign(named.paths["/map"].post.requestBody, {
    content: { schema: { $ref: "#/x-media" } },
  });
  for (const [before, after, reference] of [
    [mapDocument(), media, "#/components/schemas/MapMedia"],
    [inline, named, "#/x-media"],
  ] as const) {
    const pin = mapPin(before);
    assert.deepEqual(readKindDrift("firecrawl", pin, after), [
      `firecrawl/mapUrls: its media type is a reference, ${JSON.stringify(reference)}, which the framework would serve as written, so the hash would not cover its schema`,
    ]);
    assert.throws(() => mapHash(after), /^Error: post \/map: its media type is a reference/);
  }
});

test("a reference into component schemas outside a schema value refuses, since the framework leaves it", () => {
  const pin = mapPin(mapDocument());
  const refusal = (reference: string) =>
    `firecrawl/mapUrls: its input reference ${JSON.stringify(reference)} names a component schema outside a schema value, where the framework does not resolve it, so the hash would not cover what it serves`;
  // A whole content map, a request body, a parameter and a server written as such a reference.
  const content = mapDocument();
  Object.assign(content.components.schemas, { MapContent: mapBody(content) });
  Object.assign(content.paths["/map"].post.requestBody, {
    content: { $ref: "#/components/schemas/MapContent" },
  });
  const body = mapDocument();
  Object.assign(body.components.schemas, { MapBody: body.paths["/map"].post.requestBody });
  Object.assign(body.paths["/map"].post, { requestBody: { $ref: "#/components/schemas/MapBody" } });
  const parameter = mapDocument();
  Object.assign(parameter.components.schemas, {
    Limit: { name: "limit", in: "query", schema: { type: "integer" } },
  });
  Object.assign(parameter.paths["/map"].post, {
    parameters: [{ $ref: "#/components/schemas/Limit" }],
  });
  const server = mapDocument();
  Object.assign(server.components.schemas, { Server: server.servers[0] });
  Object.assign(server, { servers: [{ $ref: "#/components/schemas/Server" }] });
  for (const [value, reference] of [
    [content, "#/components/schemas/MapContent"],
    [body, "#/components/schemas/MapBody"],
    [parameter, "#/components/schemas/Limit"],
    [server, "#/components/schemas/Server"],
  ] as const) {
    assert.deepEqual(readKindDrift("firecrawl", pin, value), [refusal(reference)], reference);
    assert.throws(() => mapHash(value), /names a component schema outside a schema value/);
  }
  // Inside a schema value the framework resolves them, as the check does.
  const inside = mapDocument();
  Object.assign(inside.components.schemas, { Url: { type: "string" } });
  Object.assign(inside.components.schemas.MapOptions.properties, {
    url: { $ref: "#/components/schemas/Url" },
  });
  assert.deepEqual(readKindDrift("firecrawl", pin, inside), []);
});

test("a parameter whose content lists more than one media type refuses, since the framework reads only the first", () => {
  const pin = mapPin(mapDocument());
  const strict = {
    schema: {
      type: "object",
      properties: { url: { type: "string" } },
      additionalProperties: false,
    },
  };
  const loose = { schema: { type: "object" } };
  const options = (content: Record<string, typeof strict | typeof loose>) => {
    const value = mapDocument();
    Object.assign(value.paths["/map"].post, {
      parameters: [{ name: "opts", in: "query", content }],
    });
    return value;
  };
  // The hash sorts keys, so these two read alike, while the framework serves the strict schema
  // for the first and the loose one for the second. A media type named like wording counts too.
  for (const [value, types] of [
    [
      options({ "application/json": strict, "application/x-www-form-urlencoded": loose }),
      '"application/json", "application/x-www-form-urlencoded"',
    ],
    [
      options({ "application/x-www-form-urlencoded": loose, "application/json": strict }),
      '"application/x-www-form-urlencoded", "application/json"',
    ],
    [
      options({ description: loose, "application/json": strict }),
      '"description", "application/json"',
    ],
  ] as const) {
    assert.deepEqual(readKindDrift("firecrawl", pin, value), [
      `firecrawl/mapUrls: a parameter's content lists 2 media types (${types}), and the framework reads only the first, so the hash would not cover which one it serves`,
    ]);
    assert.throws(() => mapHash(value), /reads only the first/);
  }
  // One media type is an input like any other.
  assert.notEqual(mapHash(options({ "application/json": strict })), mapHash(mapDocument()));
});

test("a request body's media type named like wording is an input, since the framework serves it", () => {
  const pin = mapPin(mapDocument());
  const worded = mapDocument();
  Object.assign(mapBody(worded), { description: { schema: { type: "object" } } });
  assert.notDeepEqual(readKindDrift("firecrawl", pin, worded), []);
});

test("a server behind a reference refuses its variables too, since the framework fills them", () => {
  const pin = pinned(document());
  const address = "so the hash would not cover the address it is sent to";
  // Only the variable's default would change next, and the hash drops a variable named like
  // wording; the framework sends the read to wherever the default points.
  const operation = document();
  Object.assign(operation, {
    "x-server": {
      url: "https://api.example.test/{description}",
      variables: { description: { default: "v2" } },
    },
  });
  Object.assign(operation.paths["/scrape"].post, { servers: [{ $ref: "#/x-server" }] });
  // A path item's server takes undeclared variables from the document's server.
  const item = document();
  Object.assign(item, {
    servers: [{ url: "https://api.example.test/{v}", variables: { v: { default: "v2" } } }],
    "x-server": { url: "https://api.example.test/{v}" },
  });
  Object.assign(item.paths["/scrape"], { servers: [{ $ref: "#/x-server" }] });
  for (const [value, url] of [
    [operation, "https://api.example.test/{description}"],
    [item, "https://api.example.test/{v}"],
  ] as const) {
    const reason = `its server ${JSON.stringify(url)} has variables, ${address}`;
    assert.deepEqual(readKindDrift("example", pin, value), [`example/scrape: ${reason}`]);
    assert.throws(() => hash(value), /has variables/);
  }
});

test("a reference where the check reads a name or data refuses, since the framework follows it", () => {
  const pin = mapPin(mapDocument());
  // The framework's object resolver follows any string `$ref` outside a `schema` value, a map of
  // property names included, and the schema is then read from what it resolved.
  const names = mapDocument();
  Object.assign(names.components, {
    requestShapes: {
      MapOptions: {
        type: "object",
        properties: { $ref: "#/components/requestShapes/MapFields" },
        required: ["url"],
        additionalProperties: false,
      },
      MapFields: { url: { type: "string" } },
    },
  });
  Object.assign(mapBody(names), {
    "application/json": { schema: { $ref: "#/components/requestShapes/MapOptions" } },
  });
  // It reads a media type named `paths` as a map of path items and walks even its schema.
  const paths = mapDocument();
  Object.assign(paths, { "x-fields": { url: { type: "string" } } });
  Object.assign(paths.paths["/map"].post, {
    parameters: [
      {
        name: "opts",
        in: "query",
        content: {
          paths: {
            schema: {
              type: "object",
              properties: { $ref: "#/x-fields" },
              additionalProperties: false,
            },
          },
        },
      },
    ],
  });
  // It follows one inside an enum value as well, where the check reads data.
  const data = mapDocument();
  Object.assign(data, { "x-kind": { kind: "read" } });
  Object.assign(data.components.schemas.MapOptions.properties, {
    kind: { enum: [{ $ref: "#/x-kind" }] },
  });
  for (const [value, reference, where] of [
    [names, "#/components/requestShapes/MapFields", "a map of names"],
    [paths, "#/x-fields", "a map of names"],
    [data, "#/x-kind", "an enum, const or default value"],
  ] as const) {
    assert.deepEqual(readKindDrift("firecrawl", pin, value), [
      `firecrawl/mapUrls: its input has the reference ${JSON.stringify(reference)} inside ${where}, which the framework would follow, so the hash would not cover its target`,
    ]);
    assert.throws(() => mapHash(value), /which the framework would follow/);
  }
});

test("a schema reference through a data value refuses, since a 3.0 upgrade skips those", () => {
  const pin = mapPin(mapDocument());
  // The framework upgrades a 3.0 document before it follows references and leaves data values as
  // written, so this schema would be served un-upgraded: `nullable` and `binary` keep their 3.0
  // reading, while the same schema written in place reads `null` and any file.
  const shape = {
    type: "object",
    properties: {
      url: { type: "string" },
      limit: { type: "integer", nullable: true },
      file: { type: "string", format: "binary" },
    },
    required: ["url"],
    additionalProperties: false,
  };
  const shapes = mapDocument();
  Object.assign(shapes.components, { shapes: { default: shape } });
  Object.assign(mapBody(shapes), {
    "application/json": { schema: { $ref: "#/components/shapes/default" } },
  });
  const nested = mapDocument();
  Object.assign(nested.components.schemas, { Holder: { type: "object", default: shape } });
  Object.assign(mapBody(nested), {
    "application/json": { schema: { $ref: "#/components/schemas/Holder/default" } },
  });
  for (const [value, reference] of [
    [shapes, "#/components/shapes/default"],
    [nested, "#/components/schemas/Holder/default"],
  ] as const) {
    assert.deepEqual(readKindDrift("firecrawl", pin, value), [
      `firecrawl/mapUrls: its input reference ${JSON.stringify(reference)} cannot be followed by the check, so the hash would not cover its target`,
    ]);
    assert.throws(() => mapHash(value), /cannot be followed/);
  }
  // A component or property that is only named like a data keyword is no data value.
  const named = mapDocument();
  Object.assign(named.components.schemas, { default: shape });
  Object.assign(mapBody(named), {
    "application/json": { schema: { $ref: "#/components/schemas/default" } },
  });
  assert.doesNotThrow(() => mapHash(named));
});

test("data values and maps of names keep every key, since the framework applies them", () => {
  // An enum literal's member named like wording is part of what it accepts.
  const literal = (description: string) => {
    const value = document();
    Object.assign(value.components.schemas.Options.properties, {
      mode: { enum: [{ kind: "read", description }] },
    });
    return value;
  };
  assert.notEqual(hash(literal("cached")), hash(literal("live")));
  // So is a requirement keyed by a property named like wording.
  const required = (map: Record<string, string[]>) => {
    const value = document();
    Object.assign(value.components.schemas.Options, { dependentRequired: map });
    return value;
  };
  assert.notEqual(hash(required({ title: ["dryRun"], url: [] })), hash(required({ url: [] })));
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
