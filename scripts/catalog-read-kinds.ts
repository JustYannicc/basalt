import { createHash } from "node:crypto";

/**
 * Carried catalog apps reclassify some POST operations as reads by operationId. That decision
 * holds only for the request those operations accepted when it was reviewed: a vendor that later
 * adds a webhook or a background option would otherwise ride the read classification silently.
 * Each reviewed read pins its method, path, tags and a hash of its input surface, and each app its
 * OpenAPI version; the live check compares the vendor's current document with those pins.
 */
export type ReadKindPins = Readonly<
  Record<
    string,
    {
      readonly source: string;
      readonly openapi: Json;
      readonly operations: Readonly<
        Record<
          string,
          {
            readonly method: string;
            readonly path: string;
            readonly tags: Json;
            readonly inputSha256: string;
          }
        >
      >;
    }
  >
>;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

const methods = ["get", "post", "put", "patch", "delete", "head", "options", "query", "trace"];
// Wording and samples change often and never change what a request can do.
const documentation = new Set([
  "description",
  "summary",
  "title",
  "example",
  "examples",
  "externalDocs",
]);
// Values of these keys are maps keyed by property or definition names, never by wording.
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "dependentRequired",
  "dependencies",
]);
// Values of these keys are data the framework applies as written: every key counts.
const dataKeys = new Set(["enum", "const", "default"]);
// A 3.0 upgrade leaves these values as written unless the key names a member of a map of
// schemas, which only these maps and the component schemas are to the upgrader.
const upgradeSkips = new Set(["default", "const", "enum", "example", "examples"]);
const upgradeNames = new Set(["properties", "patternProperties", "$defs", "definitions"]);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Where a value sits in an operation's input, which decides how the framework reads it. Its
 * object resolver keeps component schemas apart and leaves the value of every `schema` key as
 * written, so only a schema value resolves references into them. A `content` map's keys are media
 * types, never wording; a media type gets no second, schema-style pass, and a parameter reads only
 * its first.
 */
type Place =
  | "object"
  | "parameter"
  | "content"
  | "parameter content"
  | "media type"
  | "schema"
  | "names"
  | "data";
const within = (place: Place, key: string): Place => {
  if (place === "data") return "data";
  if (place === "schema")
    return schemaMaps.has(key) ? "names" : dataKeys.has(key) ? "data" : "schema";
  if (place === "names") return "schema";
  if (place === "content" || place === "parameter content") return "media type";
  if (key === "schema") return "schema";
  if (key === "content") return place === "parameter" ? "parameter content" : "content";
  return key === "parameters" ? "parameter" : "object";
};

/**
 * The value a local reference names, where the framework would find the same one: a `#/` pointer
 * through the document's own object keys. The framework also decodes percent-encoding, indexes
 * arrays and resolves a reference on the way first, and reads `#/components` and
 * `#/components/schemas` with component schemas kept apart, so empty. It upgrades a 3.0 document
 * before it follows references, which leaves a schema inside a data value un-upgraded. The check
 * refuses those rather than repeat its rules.
 */
const pointer = (document: JsonObject, reference: string): Json | undefined => {
  if (!reference.startsWith("#/") || reference.includes("%")) return undefined;
  const keys = reference
    .slice(2)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (
    keys[0] === "components" &&
    (keys.length === 1 || (keys.length === 2 && keys[1] === "schemas"))
  )
    return undefined;
  const member = (index: number) =>
    upgradeNames.has(keys[index - 1] ?? "") ||
    (index === 2 && keys[0] === "components" && keys[1] === "schemas");
  if (keys.some((key, index) => upgradeSkips.has(key) && !member(index))) return undefined;
  let value: Json | undefined = document;
  for (const key of keys) {
    if (!isObject(value) || typeof value.$ref === "string" || !Object.hasOwn(value, key))
      return undefined;
    value = value[key];
  }
  return value;
};

/**
 * Everything a caller can send, with local references inlined and wording dropped, and what the
 * hash cannot stand for. Beside a reference only wording may sit: a schema adds its other
 * siblings to the target. Servers count only as lists without variables in a plain OpenAPI 3
 * document: the framework fills variables, skips servers that are not a list and converts any
 * document with a `swagger` version as Swagger 2.0. A cycle keeps its reference rather than
 * recursing.
 */
const operationInput = (document: JsonObject, found: Declared) => {
  const refused = new Set<string>();
  const { openapi, swagger } = document;
  if (typeof openapi !== "string" || !openapi.startsWith("3.") || swagger !== undefined)
    refused.add(
      `its document is not plain OpenAPI 3.x (openapi ${JSON.stringify(openapi ?? null)}, swagger ${JSON.stringify(swagger ?? null)}), so the hash would not cover how it is sent`,
    );
  const address = "so the hash would not cover the address it is sent to";
  const levels = [
    ["operation", found.operation.servers],
    ["path item", found.item.servers],
    ["document", document.servers],
  ] as const;
  for (const [level, value] of levels)
    if (value !== undefined && value !== null && !Array.isArray(value))
      refused.add(`its ${level} servers are not a list, ${address}`);
  const servers = found.operation.servers ?? found.item.servers ?? document.servers ?? null;
  const inline = (
    value: Json | undefined,
    stack: readonly string[] = [],
    place: Place = "object",
  ): Json => {
    if (Array.isArray(value))
      return value.map((item) => inline(item, stack, place === "names" ? "schema" : place));
    if (!isObject(value)) return value ?? null;
    const reference = value.$ref;
    // Outside a `schema` value the framework's object resolver follows every string `$ref`.
    if ((place === "names" || place === "data") && typeof reference === "string") {
      const where = place === "names" ? "a map of names" : "an enum, const or default value";
      refused.add(
        `its input has the reference ${JSON.stringify(reference)} inside ${where}, which the framework would follow, so the hash would not cover its target`,
      );
      return null;
    }
    if (typeof reference === "string") {
      const siblings = Object.keys(value).filter(
        (key) => key !== "$ref" && !documentation.has(key),
      );
      if (siblings.length > 0)
        refused.add(
          `its input reference ${JSON.stringify(reference)} has ${siblings.join(", ")} beside it, which the hash would leave out`,
        );
      if (place === "media type") {
        refused.add(
          `its media type is a reference, ${JSON.stringify(reference)}, which the framework would serve as written, so the hash would not cover its schema`,
        );
        return null;
      }
      if (place !== "schema" && reference.startsWith("#/components/schemas/")) {
        refused.add(
          `its input reference ${JSON.stringify(reference)} names a component schema outside a schema value, where the framework does not resolve it, so the hash would not cover what it serves`,
        );
        return null;
      }
      if (stack.includes(reference)) return { $ref: reference };
      const target = pointer(document, reference);
      if (target !== undefined) return inline(target, [...stack, reference], place);
      refused.add(
        `its input reference ${JSON.stringify(reference)} cannot be followed by the check, so the hash would not cover its target`,
      );
      return null;
    }
    const keys = Object.keys(value);
    if (place === "parameter content" && keys.length > 1)
      refused.add(
        `a parameter's content lists ${keys.length} media types (${keys.map((key) => JSON.stringify(key)).join(", ")}), and the framework reads only the first, so the hash would not cover which one it serves`,
      );
    const named = ["names", "data", "content", "parameter content"].includes(place);
    const entries = keys
      .filter((key) => named || !documentation.has(key))
      .sort()
      .map((key) => [key, inline(value[key], stack, within(place, key))]);
    return Object.fromEntries(entries);
  };
  const parameters = [
    ...(Array.isArray(found.item.parameters) ? found.item.parameters : []),
    ...(Array.isArray(found.operation.parameters) ? found.operation.parameters : []),
  ];
  const input = inline({ parameters, requestBody: found.operation.requestBody ?? null, servers });
  // Read as inlined, since a variable can sit behind a server reference too.
  const sent = isObject(input) && Array.isArray(input.servers) ? input.servers : [];
  for (const server of sent)
    if (isObject(server) && typeof server.url === "string" && server.url.includes("{"))
      refused.add(`its server ${JSON.stringify(server.url)} has variables, ${address}`);
  return { input, refused: [...refused] };
};
const sha256 = (input: Json) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** Each path item's operation slots, OpenAPI 3.2's `additionalOperations` included, unresolved. */
const pathItems = (document: JsonObject) =>
  Object.entries(isObject(document.paths) ? document.paths : {}).flatMap(([path, item]) => {
    if (!isObject(item)) return [];
    const additional = isObject(item.additionalOperations)
      ? Object.entries(item.additionalOperations)
      : [];
    const slots = [...methods.map((method) => [method, item[method]] as const), ...additional];
    return [{ path, item, slots }];
  });

/**
 * Path items, operation maps and operations written as references. The framework resolves them
 * (keeping a path item's siblings, decoding and walking pointers), so a copied operationId can
 * hide behind one; the check refuses them rather than repeat those rules.
 */
const references = (document: JsonObject) =>
  pathItems(document).flatMap(({ path, item, slots }) => [
    ...(item.$ref === undefined ? [] : [`path item ${path}`]),
    ...(isObject(item.additionalOperations) && item.additionalOperations.$ref !== undefined
      ? [`additionalOperations of ${path}`]
      : []),
    ...slots
      .filter(([method, value]) => method !== "$ref" && isObject(value) && value.$ref !== undefined)
      .map(([method]) => `${method.toLowerCase()} ${path}`),
  ]);

/** Every operation the document declares where it is written, as the framework enumerates them. */
const declaredOperations = (document: JsonObject) =>
  pathItems(document).flatMap(({ path, item, slots }) =>
    slots.flatMap(([method, operation]) =>
      isObject(operation) ? [{ method: method.toLowerCase(), path, item, operation }] : [],
    ),
  );
type Declared = ReturnType<typeof declaredOperations>[number];
const where = (found: Declared) => `${found.method} ${found.path}`;
// YAML writes an empty `operationId:` as null, which the framework reads as absent.
const malformedId = (found: Declared) =>
  found.operation.operationId !== undefined &&
  found.operation.operationId !== null &&
  typeof found.operation.operationId !== "string";

/**
 * The one operation with this operationId, with its path item. Kinds are keyed by operationId, so
 * an id that several operations declare names none of them: each would share the read kind.
 */
export const findOperation = (document: JsonObject, operationId: string) => {
  const found = declaredOperations(document).filter(
    ({ operation }) => operation.operationId === operationId,
  );
  return found.length === 1 ? found[0] : undefined;
};

/**
 * A hash of everything a caller can send: parameters, request body and servers. Throws, naming
 * them, when the input holds references the hash cannot stand for.
 */
export const operationInputSha256 = (document: JsonObject, found: Declared) => {
  const { input, refused } = operationInput(document, found);
  if (refused.length > 0) throw new Error(`${where(found)}: ${refused.join("; ")}`);
  return sha256(input);
};

const pinDrift = (
  app: string,
  pins: ReadKindPins[string],
  document: JsonObject,
  declared: readonly Declared[],
) =>
  Object.entries(pins.operations).flatMap(([operationId, pin]) => {
    const at = `${app}/${operationId}`;
    const claims = declared.filter(({ operation }) => operation.operationId === operationId);
    if (claims.length > 1)
      return [
        `${at}: ${claims.length} operations declare this operationId (${claims.map(where).join(", ")}), so its read kind would cover each of them`,
      ];
    const found = claims[0];
    if (found === undefined) {
      const there = declared.find(({ method, path }) => method === pin.method && path === pin.path);
      if (there === undefined) return [`${at}: the document no longer declares this operation`];
      return there.operation.operationId === undefined || there.operation.operationId === null
        ? [`${at}: ${where(there)} no longer declares an operationId`]
        : [`${at}: ${where(there)} no longer declares this operationId`];
    }
    const problems: string[] = [];
    if (found.method !== pin.method) problems.push(`${at}: method ${pin.method} → ${found.method}`);
    if (found.path !== pin.path) problems.push(`${at}: path ${pin.path} → ${found.path}`);
    // Tags name the tool, and an approval policy may recognise a read by its name. Naming reads
    // them as a list; anything else drops the operationId from the name.
    const tags = found.operation.tags ?? null;
    if (tags !== null && !Array.isArray(tags))
      problems.push(
        `${at}: its tags are not a list, so the framework would name its tool without its operationId`,
      );
    else if (JSON.stringify(tags) !== JSON.stringify(pin.tags))
      problems.push(
        `${at}: tags ${JSON.stringify(pin.tags)} → ${JSON.stringify(tags)}; they name its tool, so check that its approval policy still recognises it`,
      );
    const { input, refused } = operationInput(document, found);
    const inputSha256 = sha256(input);
    if (refused.length > 0) problems.push(...refused.map((reason) => `${at}: ${reason}`));
    else if (inputSha256 !== pin.inputSha256)
      problems.push(`${at}: input sha256 ${pin.inputSha256} → ${inputSha256}`);
    return problems;
  });

/**
 * Where the document has a `__proto__` key. JSON keeps it as a key and the check reads own keys,
 * but the framework copies path items and operations by assignment, which makes it the copy's
 * prototype: an operation, operationId, server or parameter could hide there.
 */
const prototypeKeys = (value: Json, at = "#"): string[] =>
  Array.isArray(value)
    ? value.flatMap((item, index) => prototypeKeys(item, `${at}/${index}`))
    : isObject(value)
      ? Object.entries(value).flatMap(([key, item]) => [
          ...(key === "__proto__" ? [at] : []),
          ...prototypeKeys(item, `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
        ])
      : [];

/** Every way a vendor document no longer matches the reviewed reads, named for the reviewer. */
export const readKindDrift = (
  app: string,
  pins: ReadKindPins[string],
  document: JsonObject,
): string[] => {
  const declared = declaredOperations(document);
  // The framework refuses a non-string operationId; a reviewed read never depends on that.
  const malformed = declared
    .filter(malformedId)
    .map(
      (found) =>
        `${app}: ${where(found)} declares a non-string operationId, ${JSON.stringify(found.operation.operationId)}`,
    );
  const referenced = references(document).map(
    (slot) => `${app}: ${slot} is a reference; the check reads operations only where written`,
  );
  const inherited = prototypeKeys(document).map(
    (at) => `${app}: ${at} has a __proto__ key, which the framework would read as inherited fields`,
  );
  // The version picks how the framework reads every schema.
  const openapi = JSON.stringify(document.openapi ?? null);
  const version =
    openapi === JSON.stringify(pins.openapi)
      ? []
      : [`${app}: openapi ${JSON.stringify(pins.openapi)} → ${openapi}`];
  return [
    ...inherited,
    ...referenced,
    ...malformed,
    ...version,
    ...pinDrift(app, pins, document, declared),
  ];
};
