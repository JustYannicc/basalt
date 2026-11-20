// What a test stand-in answers with: every declaration whose value can reach a response, directly
// or through an alias, a copy, a loop, a getter or a helper that takes the response object.
import { memberRoot, propertyName, unwrap } from "./ast.mjs";

export const ANSWERS = new Set(["end", "write", "send", "json"]);
export const RESPONDER = /^(?:res|response|reply)$/u;
const HANDLER_PARAMS = /^_?(?:req|request|incoming|input|init)$/u;
// Receivers whose `write`/`send`/`json` print or check a value rather than answer with it.
const NOT_ANSWERS = new Set(["JSON", "assert", "expect", "console", "process"]);
const HOLDS = new Set(["push", "unshift", "splice", "set", "add", "concat"]);

/** `res.json(x)`, `response.end(x)`: a call on an object named like the response. */
export const answer = (call) =>
  call.callee.type === "MemberExpression" &&
  ANSWERS.has(propertyName(call.callee)) &&
  RESPONDER.test(propertyName(call.callee.object) ?? "");
export const handler = (fn) =>
  fn.params.some((param) => param.type === "Identifier" && HANDLER_PARAMS.test(param.name));

// Identifiers in a value, without the functions nested in it.
export const identifiers = (node, found = []) => {
  if (!node || typeof node.type !== "string" || /Function/u.test(node.type)) return found;
  if (node.type === "Identifier") found.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) value.forEach((child) => identifiers(child, found));
    else if (value && typeof value === "object") identifiers(value, found);
  }
  return found;
};

// References only, not `x.name` properties or `{ name: ... }` keys.
const references = (value) =>
  identifiers(value).filter((identifier) => {
    const parent = identifier.parent;
    if (parent?.type === "MemberExpression" && parent.property === identifier && !parent.computed)
      return false;
    return !(
      parent?.type === "Property" &&
      parent.key === identifier &&
      !parent.computed &&
      !parent.shorthand
    );
  });

// The declaration a function's return lands in: `const all = () => users`, `function all()`.
const returnsInto = (fn) => {
  if (fn?.type === "FunctionDeclaration") return fn;
  return fn?.parent?.type === "VariableDeclarator" ? fn.parent : undefined;
};

/**
 * Collects, over one file, which declarations a response can reach. `visitors` must see every
 * node; `answered` is only complete once the whole file has been visited.
 */
export function answerFlow(context) {
  const reached = new WeakSet();
  // [binding, value]: once the binding is answered, so is what the value names.
  const flows = [];
  const variableOf = (identifier) => {
    for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
      const variable = scope.set.get(identifier.name);
      if (variable) return variable;
    }
    return undefined;
  };
  // A variable's declarator or a function declaration.
  const bindingOf = (identifier) => {
    const def = variableOf(identifier)?.defs.at(-1);
    return def && (def.type === "Variable" || def.type === "FunctionName") ? def.node : undefined;
  };
  const mark = (value) => {
    for (const identifier of references(value)) {
      const binding = bindingOf(identifier);
      if (binding) reached.add(binding);
    }
  };
  const visitors = {
    VariableDeclarator(node) {
      // `for (const row of users)` holds what users holds.
      const loop = node.parent?.parent;
      if (
        (loop?.type === "ForOfStatement" || loop?.type === "ForInStatement") &&
        loop.left === node.parent
      )
        flows.push([node, loop.right]);
      if (!node.init) return;
      flows.push([node, node.init]);
      // `const store = responses` is the same list both ways.
      if (unwrap(node.init)?.type === "Identifier" && node.id.type === "Identifier") {
        const original = bindingOf(unwrap(node.init));
        if (original) flows.push([original, node.id]);
      }
      if (node.init.type === "ArrowFunctionExpression" && node.init.body.type !== "BlockStatement")
        flows.push([node, node.init.body]);
    },
    // `served = users` holds what users holds, and users is served with it.
    AssignmentExpression(node) {
      if (node.left.type !== "Identifier") return;
      const binding = bindingOf(node.left);
      if (binding) flows.push([binding, node.right]);
      const original = unwrap(node.right)?.type === "Identifier" && bindingOf(unwrap(node.right));
      if (original) flows.push([original, node.left]);
    },
    ReturnStatement(node) {
      let fn = node.parent;
      while (fn && !/Function/u.test(fn.type)) fn = fn.parent;
      // What a named function returns is what a call of it answers with.
      const into = returnsInto(fn);
      if (into && node.argument) flows.push([into, node.argument]);
      if (fn && handler(fn)) mark(node.argument);
    },
    // `(request) => users` answers as much as `return users` does.
    ArrowFunctionExpression(node) {
      if (node.body.type !== "BlockStatement" && handler(node)) mark(node.body);
    },
    CallExpression(node) {
      const name = propertyName(node.callee);
      const root = memberRoot(node.callee);
      // `res.status(200).json(x)`, `c.json(x)`, `ws.send(x)` answer whatever the receiver.
      const answers =
        node.callee.type === "MemberExpression" &&
        ANSWERS.has(name) &&
        node.arguments.length > 0 &&
        !NOT_ANSWERS.has(root);
      // `send(res, users)` hands the value to whatever answers on res.
      const viaResponder = node.arguments.some(
        (argument) => argument.type === "Identifier" && RESPONDER.test(argument.name),
      );
      if (answers || viaResponder || (root === "Response" && name === "json"))
        node.arguments.forEach(mark);
      // `snapshot.push(...users)` holds what users holds.
      if (
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        HOLDS.has(name)
      ) {
        const binding = bindingOf(node.callee.object);
        if (binding) for (const argument of node.arguments) flows.push([binding, argument]);
      }
    },
    NewExpression(node) {
      if (propertyName(node.callee) === "Response") mark(node.arguments[0]);
    },
  };
  /** After the whole file: anything an answered binding holds is answered too. */
  const answered = () => {
    const seen = new WeakSet();
    for (let changed = true; changed;) {
      changed = false;
      for (const [binding, value] of flows)
        if (reached.has(binding) && !seen.has(value)) {
          seen.add(value);
          mark(value);
          changed = true;
        }
    }
    return (binding) => reached.has(binding);
  };
  return { variableOf, visitors, answered };
}
