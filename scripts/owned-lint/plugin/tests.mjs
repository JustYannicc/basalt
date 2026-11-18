// Rules for child processes and node:test: keep a failure's reason, and test the real thing.
import { SPAWNERS, importedNames, isTest, keyName, propertyName } from "./ast.mjs";

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
const NODE_TEST = /^(?:node:)?test$/u;
const NODE_TEST_REPLACERS = new Set(["method", "module", "property", "getter", "setter"]);
const TEST_CALLS = new Set(["test", "it", "describe", "suite"]);
const HOOK_CALLS = new Set(["before", "after", "beforeEach", "afterEach"]);

export const noDiscardedChildOutput = {
  meta: { type: "problem", docs: { description: "A child process keeps its error output." } },
  create(context) {
    if (isTest(context)) return {};
    const ignored = (node) => node?.type === "Literal" && node.value === "ignore";
    return {
      CallExpression(node) {
        if (!SPAWNERS.has(propertyName(node.callee))) return;
        const [command, args] = node.arguments;
        const subcommand =
          args?.type === "ArrayExpression"
            ? args.elements.find(
                (element) =>
                  element?.type === "Literal" &&
                  !String(element.value).startsWith("-") &&
                  element.value !== "-C",
              )
            : undefined;
        if (
          command?.type === "Literal" &&
          command.value === "git" &&
          GIT_PROBES.has(String(subcommand?.value))
        )
          return;
        for (const options of node.arguments) {
          if (options?.type !== "ObjectExpression") continue;
          const stdio = options.properties.find((property) => keyName(property) === "stdio")?.value;
          if (ignored(stdio) || (stdio?.type === "ArrayExpression" && ignored(stdio.elements[2])))
            context.report({
              node: stdio,
              message:
                "The child's stderr is discarded, so when it exits non-zero the error can only say it failed. Pipe stderr and attach a bounded, redacted tail of it to the error.",
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
    const mocks = importedNames(context, NODE_TEST);
    const message =
      "This replaces a dependency's behaviour, so the test proves the replacement, not the code. Run the real implementation; for an external API, run the real client against a local server that serves a recorded response. Observation-only spies (mock.fn() with no implementation) are fine.";
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        const method = propertyName(callee);
        const owner = callee.object;
        const isMock =
          (owner.type === "Identifier" && owner.name === "mock" && mocks.has("mock")) ||
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
    const inspect = (options, keys) => {
      if (options?.type !== "ObjectExpression") return;
      for (const property of options.properties) {
        const key = keyName(property);
        if (keys.has("timeout") && key === "timeout")
          context.report({ node: property, message: timeout });
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
        // Landmines covers test/it/describe timeouts; these are the node:test forms it does not see.
        if (callee.type === "MemberExpression" && name === "test")
          inspect(node.arguments[1], new Set(["timeout"]));
        else if (callee.type === "Identifier" && HOOK_CALLS.has(name))
          inspect(node.arguments[1], new Set(["timeout"]));
        else if (callee.type === "Identifier" && TEST_CALLS.has(name))
          inspect(node.arguments[1], new Set());
      },
    };
  },
};
