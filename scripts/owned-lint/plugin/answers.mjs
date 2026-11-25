// What a test stand-in answers with: every declaration whose value can reach a response, directly
// or through an alias, a copy, a member, a loop, a callback, a function a served value holds, or a
// helper that takes the response object.
import { memberRoot, memberRootNode, propertyName, unwrap } from "./ast.mjs";

const ANSWERS = new Set(["end", "write", "send", "json"]);
const RESPONDER = /^(?:res|response|reply)$/u;
const HANDLER_PARAMS = /^_?(?:req|request|incoming|input|init)$/u;
// Receivers whose `write`/`send`/`json` print or check a value rather than answer with it.
const NOT_ANSWERS = new Set(["JSON", "assert", "expect", "console", "process"]);
const HOLDS = new Set(["push", "unshift", "splice", "set", "add", "concat"]);
// Callbacks that are handed what their receiver holds.
const CALLBACKS = new Set([
  "forEach",
  "map",
  "flatMap",
  "filter",
  "find",
  "findLast",
  "some",
  "every",
  "then",
]);

/** `res.json(x)`, `response.end(x)`: a call on an object named like the response. */
export const answer = (call) =>
  call.callee.type === "MemberExpression" &&
  ANSWERS.has(propertyName(call.callee)) &&
  RESPONDER.test(propertyName(call.callee.object) ?? "");
export const handler = (fn) =>
  fn.params.some((param) => param.type === "Identifier" && HANDLER_PARAMS.test(param.name));

// Identifiers in a value, and the functions directly in it, without looking inside them.
// Every AST node has a `type`; any other property value does not.
const identifiers = (node, found = [], functions = []) => {
  if (!node?.type) return found;
  if (/Function/u.test(node.type)) {
    functions.push(node);
    return found;
  }
  if (node.type === "Identifier") found.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) value.forEach((child) => identifiers(child, found, functions));
    else if (value?.type) identifiers(value, found, functions);
  }
  return found;
};

// References only, not `x.name` properties or `{ name: ... }` keys.
const references = (value, functions) =>
  identifiers(value, [], functions).filter((identifier) => {
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
  // A variable's declarator, a function declaration or a parameter.
  const bindingOf = (identifier) => {
    const def = variableOf(identifier)?.defs.at(-1);
    if (def?.type === "Parameter") return def.name;
    return def && (def.type === "Variable" || def.type === "FunctionName") ? def.node : undefined;
  };
  // The binding a member chain hangs off: `state` for `state.users[0]`.
  const rootBinding = (node) => {
    const root = memberRootNode(unwrap(node));
    return root?.type === "Identifier" ? bindingOf(root) : undefined;
  };
  // A function in an answered value answers with what it returns.
  const mark = (value) => {
    const functions = [];
    for (const identifier of references(value, functions)) {
      const binding = bindingOf(identifier);
      if (binding) reached.add(binding);
    }
    for (const fn of functions) reached.add(fn);
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
      // `const store = responses`, `const users = state.users`, `const { users } = state`:
      // answering the original answers the alias.
      const original = rootBinding(node.init);
      if (original) flows.push([original, node.id]);
    },
    // `served = users` holds what users holds, and users is served with it;
    // `state.users = users` puts users in state.
    AssignmentExpression(node) {
      const binding =
        node.left.type === "Identifier" ? bindingOf(node.left) : rootBinding(node.left);
      if (binding) flows.push([binding, node.right]);
      if (node.left.type !== "Identifier") return;
      const original = unwrap(node.right)?.type === "Identifier" && bindingOf(unwrap(node.right));
      if (original) flows.push([original, node.left]);
    },
    ReturnStatement(node) {
      let fn = node.parent;
      while (fn && !/Function/u.test(fn.type)) fn = fn.parent;
      // What a function returns is what a call of it answers with.
      if (fn && node.argument) flows.push([fn, node.argument]);
      if (fn && handler(fn)) mark(node.argument);
    },
    // `(request) => users` answers as much as `return users` does.
    ArrowFunctionExpression(node) {
      if (node.body.type === "BlockStatement") return;
      flows.push([node, node.body]);
      if (handler(node)) mark(node.body);
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
      // `send(res, users)` hands the value to whatever answers on res; so do
      // `Readable.from(users).pipe(res)` and `.then(res.json)`, through their receiver.
      // An assertion that is handed the response checks it, it does not answer with it.
      const viaResponder =
        !NOT_ANSWERS.has(root) &&
        node.arguments.some(
          (argument) =>
            (argument.type === "Identifier" && RESPONDER.test(argument.name)) ||
            (argument.type === "MemberExpression" &&
              ANSWERS.has(propertyName(argument)) &&
              (RESPONDER.test(propertyName(argument.object) ?? "") ||
                memberRoot(argument) === "Response")),
        );
      if (viaResponder) mark(node.callee);
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
      // `Object.assign(out, row)` puts row in out.
      if (root === "Object" && name === "assign" && node.arguments.length > 1) {
        const binding = rootBinding(node.arguments[0]);
        if (binding)
          for (const argument of node.arguments.slice(1)) flows.push([binding, argument]);
      }
      // `users.forEach((row) => ...)`, `promise.then((value) => ...)`: the callback's
      // first parameter holds what the receiver holds.
      if (node.callee.type === "MemberExpression" && CALLBACKS.has(name))
        for (const argument of node.arguments)
          if (/Function/u.test(argument.type) && argument.params[0]?.type === "Identifier")
            flows.push([argument.params[0], node.callee.object]);
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
