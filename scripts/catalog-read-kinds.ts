import { createHash } from "node:crypto";

/**
 * Carried catalog apps reclassify some POST operations as reads by operationId. That decision
 * holds only for the request those operations accepted when it was reviewed: a vendor that later
 * adds a webhook or a background option would otherwise ride the read classification silently.
 * Each reviewed read pins a hash of its input surface; the live check compares the vendor's
 * current document with those pins.
 */
export type ReadKindPins = Readonly<
  Record<
    string,
    {
      readonly source: string;
      readonly operations: Readonly<
        Record<
          string,
          { readonly method: string; readonly path: string; readonly inputSha256: string }
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
// Values of these keys are maps from names to schemas, so their own keys are never wording.
const schemaMaps = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pointer = (document: JsonObject, reference: string): Json | undefined => {
  if (!reference.startsWith("#/")) return undefined;
  let value: Json | undefined = document;
  for (const token of reference.slice(2).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    value = isObject(value) ? value[key] : undefined;
  }
  return value;
};

/** Inline local references, dropping wording; a cycle keeps its reference rather than recursing. */
const surface = (
  document: JsonObject,
  value: Json | undefined,
  stack: readonly string[] = [],
  names = false,
): Json => {
  if (Array.isArray(value)) return value.map((item) => surface(document, item, stack));
  if (!isObject(value)) return value ?? null;
  const reference = value.$ref;
  if (!names && typeof reference === "string") {
    const target = pointer(document, reference);
    if (target === undefined || stack.includes(reference)) return { $ref: reference };
    return surface(document, target, [...stack, reference]);
  }
  const entries = Object.keys(value)
    .filter((key) => names || !documentation.has(key))
    .sort()
    .map((key) => [key, surface(document, value[key], stack, !names && schemaMaps.has(key))]);
  return Object.fromEntries(entries);
};

/** Follow local references, as the framework does; it refuses any other reference itself. */
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

/** A hash of everything a caller can send: parameters, request body and servers. */
export const operationInputSha256 = (
  document: JsonObject,
  found: NonNullable<ReturnType<typeof findOperation>>,
) => {
  const parameters = [
    ...(Array.isArray(found.item.parameters) ? found.item.parameters : []),
    ...(Array.isArray(found.operation.parameters) ? found.operation.parameters : []),
  ];
  const input = surface(document, {
    parameters,
    requestBody: found.operation.requestBody ?? null,
    servers: found.operation.servers ?? found.item.servers ?? document.servers ?? null,
  });
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
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
    const inputSha256 = operationInputSha256(document, found);
    if (inputSha256 !== pin.inputSha256)
      problems.push(`${at}: input sha256 ${pin.inputSha256} → ${inputSha256}`);
    return problems;
  });

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
  return [...referenced, ...malformed, ...pinDrift(app, pins, document, declared)];
};
