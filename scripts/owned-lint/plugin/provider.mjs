// Rules for code that calls providers: what goes into a request, how a response is decoded,
// how a write is compared with its read-back, and who may call Cloudflare directly.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  PROVIDER_SDK,
  SPAWNERS,
  filePath,
  importedNames,
  isTest,
  keyName,
  memberRoot,
  propertyName,
  requestTypeAnnotation,
  sdkCall,
  typedParameter,
  variableInit,
} from "./ast.mjs";

const CLOUDFLARE_SDK = /^(?:@distilled\.cloud\/cloudflare|cloudflare)(?:\/|$)/u;
const CLOUDFLARE_API = /https?:\/\/api\.cloudflare\.com|\/client\/v4(?:\/|$)/u;
// Files that talk to a provider: an SDK, Alchemy, or HTTP. Rule d only applies there.
const PROVIDER_FACING =
  /from\s+["'](?:@distilled\.cloud\/|alchemy(?:\/|["'])|@octokit\/|cloudflare(?:\/|["']))|\b(?:fetch|fetcher)\s*\(|\bprovider\??\.\w+\s*\(|HttpClient\b|https?:\/\/api\./u;
// scripts/process.ts run(command, args) and its siblings start processes too.
const COMMAND_RUNNERS = new Set([...SPAWNERS, "run", "runCommand", "capture"]);
const RUNNERS = new Set(["npx", "bunx", "pnpx", "pnpm", "yarn", "bun", "npm"]);
const SERIALIZERS = new Set(["canonical", "canonicalJson", "stableStringify"]);
const DIGESTS = /^(?:digest|hash|sha256|sha1|fingerprint)\w*$/iu;
const DEEP_EQUAL = new Set(["isDeepStrictEqual", "deepStrictEqual", "deepEqual", "isEqual"]);
const EQUIVALENCE_MODULE = /-equivalence\.[cm]?[jt]s$/u;
const EQUIVALENCE_NAME = /^equivalent[A-Z]\w*$|^\w+Equivalent$/u;
// Every object spread of a non-literal value inside a request value, at any depth. Copying a
// list (`[...tags]`) is fine; spreading an object copies keys nobody named.
function* spreads(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "ObjectExpression") {
    for (const property of node.properties)
      if (property.type !== "SpreadElement") yield* spreads(property.value);
      else if (property.argument.type === "ObjectExpression") yield* spreads(property.argument);
      else {
        yield property;
        yield* spreads(property.argument);
      }
  } else if (node.type === "ArrayExpression")
    for (const element of node.elements)
      yield* spreads(element?.type === "SpreadElement" ? element.argument : element);
  else if (node.type === "ConditionalExpression") {
    yield* spreads(node.consequent);
    yield* spreads(node.alternate);
  } else if (node.type === "LogicalExpression") yield* spreads(node.right);
  // withoutNull({ ... }) and similar wrappers pass the value through.
  else if (node.type === "CallExpression" && node.callee.type === "Identifier")
    for (const argument of node.arguments) yield* spreads(argument);
  else if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression")
    yield* spreads(node.expression);
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
      for (const node of spreads(value)) context.report({ node, message: spreadMessage });
    };
    const strictRequestDecode = (node) => {
      // Schema.decodeUnknownSync(Schema.toType(Workers.PutScriptMetadata), options)(input)
      const decoder = node.callee;
      if (decoder.type !== "CallExpression") return false;
      const [schema] = decoder.arguments;
      const text = schema ? context.sourceCode.getText(schema) : "";
      return [...types].some((name) => new RegExp(`\\b${name}\\.\\w+`, "u").test(text));
    };
    return {
      CallExpression(node) {
        if (sdkCall(node, sdk)) {
          const [request] = node.arguments;
          if (!request) return;
          if (request.type === "ObjectExpression") return reportSpreads(request);
          if (request.type === "Identifier") {
            const declarator = variableInit(context, request);
            if (declarator && requestTypeAnnotation(declarator.id.typeAnnotation, types))
              return reportSpreads(declarator.init);
            if (typedParameter(context, request, types)) return;
            context.report({ node: request, message: wholeMessage });
            return;
          }
          if (request.type === "CallExpression" || request.type === "MemberExpression")
            context.report({ node: request, message: wholeMessage });
          return;
        }
        if (strictRequestDecode(node))
          for (const argument of node.arguments) reportSpreads(argument);
      },
      VariableDeclarator(node) {
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

const serialization = (node) => {
  if (node?.type !== "CallExpression") return false;
  const name = propertyName(node.callee);
  if (!name) return false;
  if (name === "stringify")
    return node.callee.type === "MemberExpression" && memberRoot(node.callee) === "JSON";
  if (SERIALIZERS.has(name)) return true;
  const [value] = node.arguments;
  return (
    DIGESTS.test(name) &&
    (serialization(value) ||
      value?.type === "ObjectExpression" ||
      value?.type === "ArrayExpression")
  );
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
    const message =
      "Exact compare of whole values. A provider normalises, resolves and stamps what it stores, so a write never equals its read-back. Compare through a named equivalence helper (`export function <thing>Equivalent` in a `*-equivalence.ts` module) that projects the fields this step controls and is tested against a recorded read-back.";
    const report = (node) => {
      if (!insideEquivalenceHelper(context, node)) context.report({ node, message });
    };
    return {
      BinaryExpression(node) {
        // A serialised value parked in a variable first is the same compare.
        const serialized = (side) =>
          serialization(side) ||
          (side.type === "Identifier" && serialization(variableInit(context, side)?.init));
        if (
          ["===", "!==", "==", "!="].includes(node.operator) &&
          (serialized(node.left) || serialized(node.right))
        )
          report(node);
      },
      CallExpression(node) {
        const name = propertyName(node.callee);
        if (name && (DEEP_EQUAL.has(name) || comparators.has(name))) report(node);
      },
      Program(node) {
        const path = filePath(context);
        if (!EQUIVALENCE_MODULE.test(path)) return;
        const test = join(dirname(path), basename(path).replace(/\.([cm]?[jt]s)$/u, ".test.$1"));
        const recorded =
          existsSync(test) &&
          /from\s+["'][^"']*(?:-shapes?|recorded-[^"'/]*|prod-shapes\/[^"']*)(?:\.[cm]?[jt]s)?["']/u.test(
            readFileSync(test, "utf8"),
          );
        if (!recorded)
          context.report({
            node,
            message: `An equivalence helper is only as good as the read-back it was proven on. Add ${basename(test)} next to it, importing a recorded-shapes module (a *-shapes.ts file built from a real, redacted provider response).`,
          });
      },
    };
  },
};

export const noDirectCloudflareApi = {
  meta: { type: "problem", docs: { description: "Basalt reaches Cloudflare through Alchemy." } },
  create(context) {
    if (isTest(context)) return {};
    const sdk = importedNames(context, CLOUDFLARE_SDK);
    const message =
      "Direct Cloudflare control-plane call. Use the Alchemy resource or command for it (a resource in alchemy.run.ts, `alchemy plan`, `alchemy deploy`, `alchemy drift`). If Alchemy has none, add this file to scripts/owned-lint/allowlist.json under basalt/no-direct-cloudflare-api with a one-line reason.";
    const literal = (node) => typeof node?.value === "string" && CLOUDFLARE_API.test(node.value);
    const wrangler = (node) => {
      const [command, args] = node.arguments;
      if (command?.type !== "Literal" || typeof command.value !== "string") return false;
      if (/(?:^|\/)wrangler(?:\s|$)/u.test(command.value)) return true;
      if (!RUNNERS.has(command.value) || args?.type !== "ArrayExpression") return false;
      return args.elements
        .slice(0, 3)
        .some(
          (element) =>
            element?.type === "Literal" && /^wrangler(?:@|$)/u.test(String(element.value)),
        );
    };
    return {
      CallExpression(node) {
        if (
          sdkCall(node, sdk) ||
          (COMMAND_RUNNERS.has(propertyName(node.callee)) && wrangler(node))
        )
          context.report({ node, message });
      },
      Literal(node) {
        if (literal(node) && node.parent.type !== "ImportDeclaration")
          context.report({ node, message });
      },
      TemplateElement(node) {
        if (CLOUDFLARE_API.test(node.value.raw)) context.report({ node, message });
      },
    };
  },
};
