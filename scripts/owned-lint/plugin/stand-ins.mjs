// Rules for test stand-ins of external APIs: they serve recorded responses, never the request.
import {
  RECORDED_SHAPES,
  filePath,
  isTest,
  keyName,
  memberRoot,
  memberRootNode,
  propertyName,
  variableInit,
} from "./ast.mjs";

// A request body inside a stand-in: request.json(), JSON.parse(init.body), readBody(request), ...
const REQUEST_BODY =
  /\b(?:req|request|incoming|init|input|call)\b[\w?.]*\.(?:json|text|formData|arrayBuffer)\s*\(|\b(?:readBody|readJson|requestBody|bodyOf|parseBody)\s*\(|\bbody\(\s*\)|JSON\.parse\([^;]*\b(?:init|request|req|chunks|raw)\b|\b(?:init|request|req)\??\.body\b/u;
export const noEchoStub = {
  meta: {
    type: "problem",
    docs: { description: "A test stand-in never sends the request back as its response." },
  },
  create(context) {
    if (!isTest(context)) return {};
    const bodies = new WeakSet();
    const message =
      "Echo stub: the stand-in answers with what the code sent, so it can never disagree with it, and every read-then-echo or write-then-compare bug passes. Serve a recorded provider response from a recorded-shapes module and assert on the request separately.";
    const bodyName = (node) => {
      const root = memberRootNode(node);
      if (root?.type !== "Identifier") return undefined;
      const declarator = variableInit(context, root);
      return declarator && bodies.has(declarator) ? root.name : undefined;
    };
    const handler = (fn) =>
      fn.params.some((param) => param.type === "Identifier" && HANDLER_PARAMS.test(param.name));
    // Where the object holding the spread ends up: kept, returned or answered is an echo;
    // passed on to the code under test or to an assertion is not.
    const stored = (node) => {
      let current = node.parent;
      // JSON.stringify(...) and wrappers like ok(...) hand the value on unchanged.
      const passes = (parent) =>
        STRUCTURAL.has(parent?.type) ||
        (parent?.type === "CallExpression" &&
          (parent.callee.type === "Identifier" ||
            (memberRoot(parent.callee) === "JSON" && propertyName(parent.callee) === "stringify")));
      while (passes(current.parent)) current = current.parent;
      const sink = current.parent;
      if (!sink) return false;
      if (sink.type === "VariableDeclarator" || sink.type === "AssignmentExpression") return true;
      if (sink.type === "ReturnStatement" || sink.type === "ArrowFunctionExpression") return true;
      if (sink.type !== "CallExpression" && sink.type !== "NewExpression") return false;
      const name = propertyName(sink.callee);
      if (sink.type === "NewExpression") return name === "Response";
      if (memberRoot(sink.callee) === "Response") return name === "json";
      return sink.callee.type === "MemberExpression" && STORES.has(name) && !asserted(sink);
    };
    const asserted = (node) => {
      const root = memberRoot(node.callee);
      return root === "assert" || root === "expect";
    };
    // The value reaches the stand-in's answer: a Response, a written reply, or the handler's return.
    const answered = (node) => {
      for (let current = node.parent; current; current = current.parent) {
        if (current.type === "CallExpression" || current.type === "NewExpression") {
          const callee = current.callee;
          const root =
            memberRoot(callee) ?? (callee.type === "Identifier" ? callee.name : undefined);
          if (root === "assert" || root === "expect" || root === "t") return false;
          const name = propertyName(callee);
          if (current.type === "NewExpression" && name === "Response") return true;
          if (root === "Response" && name === "json") return true;
          if (["end", "write", "send", "json"].includes(name) && callee.type === "MemberExpression")
            return true;
        }
        if (/Function/u.test(current.type)) {
          const returned =
            node.parent &&
            (inReturn(node, current) ||
              (current.type === "ArrowFunctionExpression" &&
                current.body.type !== "BlockStatement"));
          return Boolean(returned) && handler(current);
        }
      }
      return false;
    };
    return {
      VariableDeclarator(node) {
        if (node.init && REQUEST_BODY.test(ownText(context, node.init))) bodies.add(node);
      },
      // Stand-ins also store what they were sent and serve it on a later read.
      SpreadElement(node) {
        if (node.parent.type === "ObjectExpression" && bodyName(node.argument) && stored(node))
          context.report({ node, message });
      },
      Property(node) {
        if (
          node.parent.type === "ObjectExpression" &&
          ["result", "data", "body"].includes(keyName(node)) &&
          bodyName(node.value) &&
          answered(node)
        )
          context.report({ node, message });
      },
      CallExpression(node) {
        const [value] = node.arguments;
        const root = memberRoot(node.callee);
        const name = propertyName(node.callee);
        if (!bodyName(value)) return;
        if (root === "Response" && name === "json") return context.report({ node, message });
        if (root === "JSON" && name === "stringify" && answered(node))
          context.report({ node, message });
      },
    };
  },
};
const HANDLER_PARAMS = /^_?(?:req|request|incoming|input|init)$/u;
const STRUCTURAL = new Set([
  "ObjectExpression",
  "Property",
  "ArrayExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "AwaitExpression",
]);
const STORES = new Set([
  "push",
  "unshift",
  "set",
  "splice",
  "assign",
  "resolve",
  "end",
  "write",
  "send",
  "json",
]);
// An initializer's own text, without the functions nested in it: a fixture built from a
// handler that reads its request is not itself a request body.
const ownText = (context, node) => {
  const text = context.sourceCode.getText(node);
  const [start] = node.range;
  const nested = [];
  const visit = (child) => {
    if (!child || typeof child.type !== "string") return;
    if (child !== node && /Function/u.test(child.type)) return void nested.push(child.range);
    for (const [key, value] of Object.entries(child)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  visit(node);
  return nested
    .sort((a, b) => b[0] - a[0])
    .reduce((kept, [from, to]) => kept.slice(0, from - start) + kept.slice(to - start), text);
};
const inReturn = (node, fn) => {
  for (let current = node.parent; current && current !== fn; current = current.parent)
    if (current.type === "ReturnStatement") return true;
  return false;
};
export const noHandwrittenProviderResponse = {
  meta: {
    type: "problem",
    docs: { description: "Test stand-ins serve provider bodies from recorded-shapes modules." },
  },
  create(context) {
    if (!isTest(context) || RECORDED_SHAPES.test(filePath(context))) return {};
    return {
      ObjectExpression(node) {
        const keys = new Set(node.properties.map(keyName));
        if (!keys.has("success") || !(keys.has("result") || keys.has("errors"))) return;
        const result = node.properties.find((property) => keyName(property) === "result")?.value;
        if (
          result &&
          result.type !== "ObjectExpression" &&
          result.type !== "ArrayExpression" &&
          result.type !== "Literal"
        )
          return;
        context.report({
          node,
          message:
            "Hand-written provider response in a test stand-in: it has the shape the author expected, not the one the provider returns (missing keys, null instead of [], no result_info). Serve the body from a recorded-shapes module (production-*-shape.ts, built from a real response) and change only the fields the test is about there.",
        });
      },
    };
  },
};
