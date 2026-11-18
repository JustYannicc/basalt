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

const methods = ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"];
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

/** The operation with this operationId, with its path item, or undefined. */
export const findOperation = (document: JsonObject, operationId: string) => {
  const paths = isObject(document.paths) ? document.paths : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of methods) {
      const operation = item[method];
      if (isObject(operation) && operation.operationId === operationId)
        return { method, path, item, operation };
    }
  }
  return undefined;
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

/** Every way a vendor document no longer matches the reviewed reads, named for the reviewer. */
export const readKindDrift = (
  app: string,
  pins: ReadKindPins[string],
  document: JsonObject,
): string[] =>
  Object.entries(pins.operations).flatMap(([operationId, pin]) => {
    const found = findOperation(document, operationId);
    const at = `${app}/${operationId}`;
    if (found === undefined) return [`${at}: the document no longer declares this operation`];
    const problems: string[] = [];
    if (found.method !== pin.method) problems.push(`${at}: method ${pin.method} → ${found.method}`);
    if (found.path !== pin.path) problems.push(`${at}: path ${pin.path} → ${found.path}`);
    const inputSha256 = operationInputSha256(document, found);
    if (inputSha256 !== pin.inputSha256)
      problems.push(`${at}: input sha256 ${pin.inputSha256} → ${inputSha256}`);
    return problems;
  });
