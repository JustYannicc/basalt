// Rules for test stand-ins of external APIs: they serve recorded responses, never the request.
import {
  RECORDED_SHAPES,
  filePath,
  isTest,
  keyName,
  memberRoot,
  memberRootNode,
  propertyName,
  unwrap,
  variableInit,
} from "./ast.mjs";

// A request body inside a stand-in: request.json(), JSON.parse(init.body), readBody(request), ...
const REQUEST_BODY =
  /\b(?:req|request|incoming|init|input|call)\b[\w?.]*\.(?:json|text|formData|arrayBuffer)\s*\(|\b(?:readBody|readJson|requestBody|bodyOf|parseBody)\s*\(|\bbody\(\s*\)|JSON\.parse\([^;]*\b(?:init|request|req|chunks|raw)\b|\b(?:init|request|req)\??\.body\b/u;
const HANDLER_PARAMS = /^_?(?:req|request|incoming|input|init)$/u;
// Nodes a value passes through unchanged on its way to where it is kept or sent.
const STRUCTURAL = new Set([
  "ObjectExpression",
  "Property",
  "ArrayExpression",
  "ConditionalExpression",
  "LogicalExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "AwaitExpression",
]);
const STORES = new Set(["push", "unshift", "set", "splice"]);
const ANSWERS = new Set(["end", "write", "send", "json"]);
// A request kept to assert on later is the honest pattern, not an echo.
const RECORDER =
  /(?:calls|requests|writes|posted|posts|events|seen|received|captured|recorded|sent|logs?|history|bodies|payloads|updates|envelopes|messages)$/iu;
const RESPONDER = /^(?:res|response|reply)$/u;
// A collection that keeps what it was sent: `users.push(...)`, not `requests.push(...)`.
const store = (call) =>
  call.callee.type === "MemberExpression" &&
  STORES.has(propertyName(call.callee)) &&
  !RECORDER.test(propertyName(call.callee.object) ?? "");
const answer = (call) =>
  call.callee.type === "MemberExpression" &&
  ANSWERS.has(propertyName(call.callee)) &&
  RESPONDER.test(propertyName(call.callee.object) ?? "");
const message =
  "Echo stub: the stand-in answers with what the code sent, so it can never disagree with it, and every read-then-echo or write-then-compare bug passes. Serve a recorded provider response from a recorded-shapes module and assert on the request separately.";

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
const BODY_READERS = new Set([
  "json",
  "text",
  "formData",
  "arrayBuffer",
  "parse",
  "decode",
  "readBody",
  "readJson",
  "requestBody",
  "bodyOf",
  "parseBody",
  "body",
]);
// The initializer itself reads the request body; a call that only passes the body on (a proxy
// forwarding it to the real upstream) returns something else.
const readsBody = (context, input) => {
  const node = unwrap(input);
  if (!node) return false;
  if (node.type === "ConditionalExpression")
    return readsBody(context, node.consequent) || readsBody(context, node.alternate);
  if (node.type === "LogicalExpression")
    return readsBody(context, node.left) || readsBody(context, node.right);
  if (node.type === "CallExpression" && !BODY_READERS.has(propertyName(node.callee))) return false;
  if (node.type !== "CallExpression" && node.type !== "MemberExpression") return false;
  return REQUEST_BODY.test(ownText(context, node));
};
const asserted = (call) => ["assert", "expect"].includes(memberRoot(call.callee));
const handler = (fn) =>
  fn.params.some((param) => param.type === "Identifier" && HANDLER_PARAMS.test(param.name));

export const noEchoStub = {
  meta: {
    type: "problem",
    docs: { description: "A test stand-in never sends the request back as its response." },
  },
  create(context) {
    if (!isTest(context)) return {};
    const bodies = new WeakSet();
    // The request body, or structuredClone of it, or a member of it.
    const bodyName = (input) => {
      let node = unwrap(input);
      if (
        node?.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "structuredClone"
      )
        node = unwrap(node.arguments[0]);
      const root = memberRootNode(node);
      if (root?.type !== "Identifier") return undefined;
      const declarator = variableInit(context, root);
      return declarator && bodies.has(declarator) ? root.name : undefined;
    };
    // Where a value ends up: kept, returned or answered is an echo; passed on to the code
    // under test or to an assertion is not.
    const kept = (node) => {
      let current = node;
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
      return (
        (store(sink) ||
          answer(sink) ||
          (memberRoot(sink.callee) === "Object" && name === "assign")) &&
        !asserted(sink)
      );
    };
    return {
      VariableDeclarator(node) {
        if (!node.init) return;
        // `const sent = body` is still the request body.
        if (readsBody(context, node.init) || bodyName(node.init)) bodies.add(node);
      },
      SpreadElement(node) {
        if (node.parent.type === "ObjectExpression" && bodyName(node.argument) && kept(node.parent))
          context.report({ node, message });
      },
      Property(node) {
        if (
          node.parent.type === "ObjectExpression" &&
          ["result", "data"].includes(keyName(node)) &&
          bodyName(node.value) &&
          kept(node.parent)
        )
          context.report({ node, message });
      },
      // `app = body` or `state.app.policy = body.policy`: what was sent is what a later read returns.
      AssignmentExpression(node) {
        if (node.left.type === "ObjectPattern" || !bodyName(node.right)) return;
        if (node.left.type !== "Identifier" || !variableInit(context, node.left)?.init)
          context.report({ node, message });
      },
      ReturnStatement(node) {
        let fn = node.parent;
        while (fn && !/Function/u.test(fn.type)) fn = fn.parent;
        if (fn && handler(fn) && bodyName(node.argument)) context.report({ node, message });
      },
      CallExpression(node) {
        const name = propertyName(node.callee);
        const root = memberRoot(node.callee);
        // Object.assign(stored, body) and users.push(body) keep what was sent.
        if (
          root === "Object" &&
          name === "assign" &&
          node.arguments.slice(1).some((argument) => bodyName(argument)) &&
          !asserted(node.parent ?? node)
        )
          return context.report({ node, message });
        if ((store(node) || answer(node)) && node.arguments.some((argument) => bodyName(argument)))
          return context.report({ node, message });
        const [value] = node.arguments;
        if (bodyName(value) && root === "Response" && name === "json")
          context.report({ node, message });
      },
      NewExpression(node) {
        if (propertyName(node.callee) === "Response" && bodyName(node.arguments[0]))
          context.report({ node, message });
      },
    };
  },
};

export const noHandwrittenProviderResponse = {
  meta: {
    type: "problem",
    docs: { description: "Test stand-ins serve provider bodies from recorded-shapes modules." },
  },
  create(context) {
    if (!isTest(context) || RECORDED_SHAPES.test(filePath(context))) return {};
    // A literal written here, directly or in a local constant; an imported recording is not.
    const literal = (input) => {
      const node = unwrap(input);
      if (!node || ["ObjectExpression", "ArrayExpression", "Literal"].includes(node.type))
        return true;
      if (node.type !== "Identifier") return false;
      const init = unwrap(variableInit(context, node)?.init);
      return init?.type === "ObjectExpression" || init?.type === "ArrayExpression";
    };
    return {
      ObjectExpression(node) {
        const keys = new Set(node.properties.map(keyName));
        if (!keys.has("success") || !(keys.has("result") || keys.has("errors"))) return;
        const result = node.properties.find((property) => keyName(property) === "result")?.value;
        if (result && !literal(result)) return;
        context.report({
          node,
          message:
            "Hand-written provider response in a test stand-in: it has the shape the author expected, not the one the provider returns (missing keys, null instead of [], no result_info). Serve the body from a recorded-shapes module (a *-shapes.ts file built from a real, redacted response) and change only the fields the test is about there.",
        });
      },
    };
  },
};
