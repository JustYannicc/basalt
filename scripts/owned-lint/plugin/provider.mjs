// Rules for code that calls providers: what goes into a request, how a response is decoded,
// how a write is compared with its read-back, and who may call Cloudflare directly.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  PROVIDER_SDK,
  absolutePath,
  addAliases,
  filePath,
  importAliases,
  importedNames,
  isTest,
  keyName,
  memberRoot,
  propertyName,
  requestTypeAnnotation,
  sdkCall,
  typedParameter,
  unwrap,
  variableInit,
} from "./ast.mjs";

// Files that talk to a provider: an SDK, Alchemy, or HTTP. The read-back rule applies only there.
const PROVIDER_FACING =
  /from\s+["'](?:@distilled\.cloud\/|alchemy(?:\/|["'])|@octokit\/|cloudflare(?:\/|["']))|\b(?:fetch|fetcher)\s*\(|\bprovider\??\.\w+\s*\(|HttpClient\b|https?:\/\/api\./u;
const SERIALIZER = /^(?:canonical|stable)\w*$|Stringify$|^stringify$/u;
const DIGEST = /^(?:digest|hash|sha\d*|fingerprint)\w*$/iu;
const DEEP_EQUAL = new Set([
  "isDeepStrictEqual",
  "deepStrictEqual",
  "deepEqual",
  "isEqual",
  "equals",
]);
const EQUIVALENCE_MODULE = /-equivalence\.[cm]?[jt]s$/u;
const EQUIVALENCE_NAME = /^equivalent[A-Z]\w*$|^\w+Equivalent$/u;
// A value import with at least one binding: `import type` and `import {}` prove nothing.
const RECORDED_IMPORT =
  /^\s*import\s+(?!type\b)(?:[\w$]+|\*\s*as\s+[\w$]+|\{\s*[\w$][^}]*\})[^;]*?\bfrom\s+["']([^"']*(?:-shapes?|recorded-[^"'/]*|prod-shapes\/[^"']*)(?:\.[cm]?[jt]s)?)["']/gmu;

// A copy of a whole object: Object.assign, Object.fromEntries, structuredClone.
const copies = (node) =>
  node.type === "CallExpression" &&
  ((memberRoot(node.callee) === "Object" &&
    ["assign", "fromEntries"].includes(propertyName(node.callee))) ||
    (node.callee.type === "Identifier" && node.callee.name === "structuredClone"));

// Every object spread or whole-object copy of a non-literal value inside a request value, at
// any depth. Copying a list (`[...tags]`) is fine; spreading an object copies keys nobody named.
function* spreads(input, context, seen = new Set()) {
  let node = unwrap(input);
  // A request field held in a local constant first is the same value.
  if (node?.type === "Identifier" && !seen.has(node.name)) {
    seen.add(node.name);
    node = unwrap(variableInit(context, node)?.init);
  }
  if (!node || typeof node !== "object") return;
  if (node.type === "ObjectExpression") {
    for (const property of node.properties)
      if (property.type !== "SpreadElement") yield* spreads(property.value, context, seen);
      else if (unwrap(property.argument).type === "ObjectExpression")
        yield* spreads(property.argument, context, seen);
      else {
        yield property;
        yield* spreads(property.argument, context, seen);
      }
  } else if (node.type === "ArrayExpression")
    for (const element of node.elements)
      yield* spreads(element?.type === "SpreadElement" ? element.argument : element, context, seen);
  else if (node.type === "ConditionalExpression") {
    yield* spreads(node.consequent, context, seen);
    yield* spreads(node.alternate, context, seen);
  } else if (node.type === "LogicalExpression") yield* spreads(node.right, context, seen);
  else if (
    copies(node) &&
    node.arguments.some((argument) => unwrap(argument).type !== "ObjectExpression")
  )
    yield node;
  // withoutNull({ ... }) and similar wrappers pass the value through.
  else if (node.type === "CallExpression" && node.callee.type === "Identifier")
    for (const argument of node.arguments) yield* spreads(argument, context, seen);
}

export const noSpreadIntoProviderRequest = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Provider SDK requests are built from named fields, never from a spread or a whole object.",
    },
  },
  create(context) {
    if (isTest(context)) return {};
    const sdk = importedNames(context, PROVIDER_SDK);
    const types = importedNames(context, PROVIDER_SDK, { values: false });
    if (!types.size) return {};
    const spreadMessage =
      "Spread into a provider request: every key the source holds goes on the wire, so a GET gets a JSON body and a read-only annotation goes into a PUT. Name each field the request needs, e.g. { accountId: target.accountId, scriptName: target.scriptName }.";
    const wholeMessage =
      "A whole object is passed as a provider request. Pass an object literal with the request's fields named, or a value declared with the SDK's request type (`const request: Workers.PutScriptRequest = { ... }`).";
    const reportSpreads = (value) => {
      for (const node of spreads(value, context)) context.report({ node, message: spreadMessage });
    };
    // Schema.decodeUnknownSync(Schema.toType(Workers.PutScriptMetadata), options)(input)
    const strictRequestDecode = (node) => {
      const decoder = node.callee;
      if (decoder.type !== "CallExpression") return false;
      const [schema] = decoder.arguments;
      const text = schema ? context.sourceCode.getText(schema) : "";
      return [...types].some((name) => new RegExp(`\\b${name}\\.\\w+`, "u").test(text));
    };
    return {
      CallExpression(node) {
        if (!sdkCall(node, sdk)) {
          if (strictRequestDecode(node))
            for (const argument of node.arguments) reportSpreads(argument);
          return;
        }
        const request = unwrap(node.arguments[0]);
        if (!request) return;
        if (request.type === "ObjectExpression") return reportSpreads(request);
        if (request.type === "Identifier") {
          const declarator = variableInit(context, request);
          if (declarator && requestTypeAnnotation(declarator.id.typeAnnotation, types))
            return reportSpreads(declarator.init);
          if (typedParameter(context, request, types)) return;
        }
        context.report({ node: request, message: wholeMessage });
      },
      VariableDeclarator(node) {
        addAliases(node, sdk);
        if (requestTypeAnnotation(node.id.typeAnnotation, types)) reportSpreads(node.init);
      },
      ReturnStatement(node) {
        let fn = node.parent;
        while (fn && !/Function/u.test(fn.type)) fn = fn.parent;
        if (fn && requestTypeAnnotation(fn.returnType, types)) reportSpreads(node.argument);
      },
      ArrowFunctionExpression(node) {
        if (node.body.type !== "BlockStatement" && requestTypeAnnotation(node.returnType, types))
          reportSpreads(node.body);
      },
    };
  },
};

export const noStrictProviderDecode = {
  meta: {
    type: "problem",
    docs: { description: 'onExcessProperty "error" is only for data Basalt wrote itself.' },
  },
  create(context) {
    if (isTest(context)) return {};
    const types = importedNames(context, PROVIDER_SDK, { values: false });
    const providerSchema = (node) => {
      let call = node.parent;
      while (call && call.type !== "CallExpression") call = call.parent;
      const schema = call?.arguments[0];
      const text = schema ? context.sourceCode.getText(schema) : "";
      const named = (suffix) =>
        [...types].some((name) => new RegExp(`\\b${name}\\.\\w*(?:${suffix})\\b`, "u").test(text));
      // A request Basalt builds may be strict; that is what catches an echoed read-only key.
      return named("Response|Result")
        ? "response"
        : named("Request|Metadata|Body|Input")
          ? "request"
          : undefined;
    };
    return {
      Property(node) {
        if (keyName(node) !== "onExcessProperty") return;
        const value = node.value;
        if (value.type === "Literal" && (value.value === "ignore" || value.value === "preserve"))
          return;
        const schema = providerSchema(node);
        if (schema === "request") return;
        context.report({
          node,
          message:
            schema === "response"
              ? "Strict decode of a provider response: it refuses the release the day the provider adds a key. Decode with the default (excess keys ignored) and read the fields you need."
              : 'Strict decode. Only data Basalt wrote itself (a journal, a receipt, our own request) may be decoded with onExcessProperty "error"; a value read from a provider must use the default. If this decoder only ever sees our own data, add the file to scripts/owned-lint/allowlist.json with that reason.',
        });
      },
    };
  },
};

const insideEquivalenceHelper = (context, node) => {
  if (!EQUIVALENCE_MODULE.test(filePath(context))) return false;
  for (let current = node.parent; current; current = current.parent) {
    const name =
      current.type === "FunctionDeclaration"
        ? current.id?.name
        : /Function/u.test(current.type) && current.parent?.type === "VariableDeclarator"
          ? current.parent.id.name
          : undefined;
    if (name && EQUIVALENCE_NAME.test(name)) return true;
  }
  return false;
};
// The helper's test must import a recorded-shapes module that exists next to it.
const provenOnRecording = (test) => {
  if (!existsSync(test)) return false;
  const code = readFileSync(test, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const [, specifier] of code.matchAll(RECORDED_IMPORT)) {
    const target = resolve(dirname(test), specifier);
    if (
      existsSync(target) ||
      ["ts", "mts", "js", "mjs"].some((extension) => existsSync(`${target}.${extension}`))
    )
      return true;
  }
  return false;
};

export const noExactReadbackCompare = {
  meta: {
    type: "problem",
    docs: {
      description:
        "What was sent and what a provider read back are compared through a named equivalence helper.",
    },
    schema: [
      {
        type: "object",
        properties: { comparators: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (isTest(context) || !PROVIDER_FACING.test(context.sourceCode.text)) return {};
    const comparators = new Set(context.options[0]?.comparators ?? []);
    const aliases = importAliases(context);
    const named = (node) => {
      const name = propertyName(node.callee);
      return node.callee.type === "Identifier" ? (aliases.get(name) ?? name) : name;
    };
    const message =
      "Exact compare of whole values. A provider normalises, resolves and stamps what it stores, so a write never equals its read-back. Compare through a named equivalence helper (`export function <thing>Equivalent` in a `*-equivalence.ts` module) that projects the fields this step controls and is tested against a recorded read-back.";
    const report = (node) => {
      if (!insideEquivalenceHelper(context, node)) context.report({ node, message });
    };
    const serialization = (input) => {
      const node = unwrap(input);
      if (node?.type !== "CallExpression") return false;
      let name = named(node);
      // `const encode = JSON.stringify` is still JSON.stringify.
      const alias =
        node.callee.type === "Identifier"
          ? unwrap(variableInit(context, node.callee)?.init)
          : undefined;
      if (alias?.type === "MemberExpression") name = propertyName(alias);
      if (!name) return false;
      if (SERIALIZER.test(name)) return true;
      if (!DIGEST.test(name)) return false;
      // `createHash(...).update(x).digest("hex")` and `digest(x)` both stand for the whole value.
      return (
        node.callee.type === "MemberExpression" ||
        node.arguments.some((argument) => argument.type !== "Literal")
      );
    };
    const serialized = (side) =>
      serialization(side) ||
      (side.type === "Identifier" && serialization(variableInit(context, side)?.init));
    return {
      BinaryExpression(node) {
        // Both sides serialised is a compare of two whole values; one side against a stored
        // digest is an integrity check of our own data.
        if (
          ["===", "!==", "==", "!="].includes(node.operator) &&
          serialized(node.left) &&
          serialized(node.right)
        )
          report(node);
      },
      CallExpression(node) {
        const name = named(node);
        if (name && (DEEP_EQUAL.has(name) || comparators.has(name))) report(node);
      },
      Program(node) {
        const path = absolutePath(context);
        if (!EQUIVALENCE_MODULE.test(path)) return;
        const test = join(dirname(path), basename(path).replace(/\.([cm]?[jt]s)$/u, ".test.$1"));
        if (!provenOnRecording(test))
          context.report({
            node,
            message: `An equivalence helper is only as good as the read-back it was proven on. Add ${basename(test)} next to it, importing a recorded-shapes module (a *-shapes.ts file built from a real, redacted provider response).`,
          });
      },
    };
  },
};
