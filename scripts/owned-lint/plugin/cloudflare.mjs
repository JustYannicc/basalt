// Basalt reaches the Cloudflare control plane through Alchemy, not by calling it directly.
import {
  SPAWNERS,
  addAliases,
  importedNames,
  isTest,
  memberRoot,
  propertyName,
  sdkCall,
} from "./ast.mjs";

const CLOUDFLARE_SDK = /^(?:@distilled\.cloud\/cloudflare|cloudflare)(?:\/|$)/u;
const CLOUDFLARE_API = /https?:\/\/api\.cloudflare\.com|\/client\/v4(?:\/|$)/u;
const WRANGLER = /(?:^|[\s/])wrangler(?:[\s@]|$)/u;
// scripts/process.ts run(command, args) and its siblings start processes too.
const COMMAND_RUNNERS = new Set([...SPAWNERS, "run", "runCommand", "capture"]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx", "pnpx", "pnpm", "yarn", "bun", "npm"]);

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
      if (WRANGLER.test(command.value)) return true;
      if (!PACKAGE_RUNNERS.has(command.value) || args?.type !== "ArrayExpression") return false;
      return args.elements
        .slice(0, 3)
        .some(
          (element) =>
            element?.type === "Literal" && /^wrangler(?:@|$)/u.test(String(element.value)),
        );
    };
    const wranglerModule = (node) => node?.type === "Literal" && node.value === "wrangler";
    return {
      VariableDeclarator(node) {
        addAliases(node, sdk);
      },
      CallExpression(node) {
        // createRequire(import.meta.url)("wrangler") loads Wrangler's API directly.
        const required = node.callee.type === "CallExpression" && wranglerModule(node.arguments[0]);
        if (
          sdkCall(node, sdk) ||
          required ||
          (COMMAND_RUNNERS.has(propertyName(node.callee)) && wrangler(node))
        )
          context.report({ node, message });
      },
      NewExpression(node) {
        if (sdk.has(propertyName(node.callee)) || sdk.has(memberRoot(node.callee)))
          context.report({ node, message });
      },
      ImportDeclaration(node) {
        if (wranglerModule(node.source)) context.report({ node, message });
      },
      ImportExpression(node) {
        if (wranglerModule(node.source)) context.report({ node, message });
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
