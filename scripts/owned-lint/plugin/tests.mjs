// Rules for child processes and node:test: keep a failure's reason, and test the real thing.
import { SPAWNERS, isTest, keyName, propertyName, resolved, unwrap } from "./ast.mjs";

// git subcommands whose exit status is the whole answer.
const GIT_PROBES = new Set([
  "cat-file",
  "rev-parse",
  "diff",
  "apply",
  "merge-base",
  "show-ref",
  "check-ignore",
  "ls-files",
]);
const DISCARDED_SHELL = /2>\s*(?:\/dev\/null|&-)/u;
const NODE_TEST = /^(?:node:)?test$/u;
const NODE_TEST_REPLACERS = new Set(["method", "module", "property", "getter", "setter"]);
const TEST_CALLS = new Set(["test", "it", "describe", "suite"]);
const HOOK_CALLS = new Set(["before", "after", "beforeEach", "afterEach"]);

// The options object, read through a local constant, a cast or spreads of other constants.
const optionProperties = (context, node, depth = 0) => {
  const options = resolved(context, node);
  if (options?.type !== "ObjectExpression" || depth > 3) return [];
  return options.properties.flatMap((property) =>
    property.type === "SpreadElement"
      ? optionProperties(context, property.argument, depth + 1)
      : [property],
  );
};

export const noDiscardedChildOutput = {
  meta: { type: "problem", docs: { description: "A child process keeps its error output." } },
  create(context) {
    if (isTest(context)) return {};
    const message =
      "The child's stderr is discarded, so when it exits non-zero the error can only say it failed. Pipe stderr and attach a bounded, redacted tail of it to the error.";
    const ignored = (node) => {
      const value = resolved(context, node);
      return value?.type === "Literal" && value.value === "ignore";
    };
    return {
      CallExpression(node) {
        const name = propertyName(node.callee);
        // Node's child_process functions; Bun.spawn and Bun.spawnSync name the option stderr.
        if (!SPAWNERS.has(name)) return;
        const [command, args] = node.arguments;
        const list = resolved(context, args);
        const subcommand =
          list?.type === "ArrayExpression"
            ? list.elements.find(
                (element) => element?.type === "Literal" && !String(element.value).startsWith("-"),
              )
            : undefined;
        if (
          command?.type === "Literal" &&
          command.value === "git" &&
          GIT_PROBES.has(String(subcommand?.value))
        )
          return;
        const words = [command, ...(list?.type === "ArrayExpression" ? list.elements : [])];
        const shell = words.find(
          (word) =>
            word?.type === "Literal" &&
            typeof word.value === "string" &&
            DISCARDED_SHELL.test(word.value),
        );
        if (shell) return context.report({ node: shell, message });
        for (const argument of node.arguments.slice(1))
          for (const property of optionProperties(context, argument)) {
            const key = keyName(property);
            const value = unwrap(property.value);
            const discarded =
              (key === "stdio" &&
                (ignored(value) ||
                  (value?.type === "ArrayExpression" && ignored(value.elements[2])))) ||
              (key === "stderr" && ignored(value));
            // Report where the call is when the option comes from a shared constant.
            if (discarded)
              context.report({
                node: property.parent === unwrap(argument) ? property : argument,
                message,
              });
          }
      },
    };
  },
};

export const noNodeTestDoubles = {
  meta: {
    type: "problem",
    docs: { description: "node:test mocks do not replace dependency behaviour." },
  },
  create(context) {
    if (!isTest(context)) return {};
    // `import { mock as m } from "node:test"` is still the mock tracker.
    const mocks = new Set();
    for (const statement of context.sourceCode.ast.body)
      if (statement.type === "ImportDeclaration" && NODE_TEST.test(statement.source.value))
        for (const specifier of statement.specifiers)
          if (
            specifier.type === "ImportSpecifier" &&
            (specifier.imported.name ?? specifier.imported.value) === "mock"
          )
            mocks.add(specifier.local.name);
    const message =
      "This replaces a dependency's behaviour, so the test proves the replacement, not the code. Run the real implementation; for an external API, run the real client against a local server that serves a recorded response. Observation-only spies (mock.fn() with no implementation) are fine.";
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const method = propertyName(callee);
        const owner = callee.object;
        const isMock =
          (owner.type === "Identifier" && mocks.has(owner.name)) ||
          (owner.type === "MemberExpression" && propertyName(owner) === "mock");
        if (!isMock) return;
        // Clock control and output capture are not dependency behaviour.
        const target = node.arguments[0] ? context.sourceCode.getText(node.arguments[0]) : "";
        if (
          method === "method" &&
          /^(?:Date|performance|console|process\.std(?:out|err))$/u.test(target)
        )
          return;
        if (NODE_TEST_REPLACERS.has(method) || (method === "fn" && node.arguments.length > 0))
          context.report({ node, message });
      },
    };
  },
};

export const noNodeTestFlakeMasking = {
  meta: {
    type: "problem",
    docs: { description: "node:test subtests, hooks and skips do not hide flakes." },
  },
  create(context) {
    if (!isTest(context)) return {};
    const timeout =
      "Do not raise a test's timeout. Wait on the event the test depends on, or move slow shared setup into a before hook.";
    const skip =
      "Do not skip a test on a condition. If it needs a tool or a service, make that a declared prerequisite so the test fails loudly when it is missing.";
    const inspect = (options, timeouts) => {
      for (const property of optionProperties(context, options)) {
        const key = keyName(property);
        if (timeouts && key === "timeout") context.report({ node: property, message: timeout });
        if (
          (key === "skip" || key === "todo") &&
          !(property.value.type === "Literal" && property.value.value === false)
        )
          context.report({ node: property, message: skip });
      }
    };
    return {
      CallExpression(node) {
        const callee = node.callee;
        const name = propertyName(callee);
        if (callee.type === "MemberExpression" && (name === "skip" || name === "todo")) {
          const owner = propertyName(callee.object);
          if (TEST_CALLS.has(owner) || /^(?:t|context|ctx)$/u.test(owner ?? ""))
            return context.report({ node, message: skip });
        }
        // landmines covers test/it/describe timeouts; these are the node:test forms it does not see.
        if (callee.type === "MemberExpression" && (name === "test" || HOOK_CALLS.has(name)))
          inspect(node.arguments[1], true);
        else if (callee.type === "Identifier" && HOOK_CALLS.has(name))
          inspect(node.arguments[1], true);
        else if (callee.type === "Identifier" && TEST_CALLS.has(name))
          inspect(node.arguments[1], false);
      },
    };
  },
};
