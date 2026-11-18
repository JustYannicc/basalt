// Alchemy 2.0.0-beta.80's CLI flag `--yes` does more than approve the plan: it also sets
// updateStateStore, and a brief failure of the shared State store's /version probe then redeploys
// the store and rotates its token under production. Apply and destroy run in-process through the
// release entry with updateStateStore: false, so no command line may pass `--yes` to Alchemy.
const AUTO_APPROVE = new Set(["--yes", "-y"]);
const COMMAND_TEXT = /(?:^|[\s"'`/])alchemy\s[^\n]*?\s(?:--yes|-y)(?=[\s"'`]|$)/u;
const MESSAGE =
  "Alchemy's CLI --yes also sets updateStateStore and can redeploy the shared State store. Apply and destroy go through the release entry in-process with updateStateStore: false.";

const text = (node) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : node?.type === "TemplateLiteral" && node.expressions.length === 0
      ? node.quasis[0].value.cooked
      : undefined;

export const noAlchemyAutoApprove = {
  meta: { type: "problem", docs: { description: MESSAGE } },
  create(context) {
    return {
      // ["exec", "alchemy", action, config, "--yes"]: the verb is often a variable.
      ArrayExpression(node) {
        const words = node.elements.map(text);
        if (!words.includes("alchemy")) return;
        const flag = node.elements.find((element) => AUTO_APPROVE.has(text(element)));
        if (flag) context.report({ node: flag, message: MESSAGE });
      },
      // "bunx alchemy deploy --yes" as one command string.
      Literal(node) {
        if (typeof node.value === "string" && COMMAND_TEXT.test(node.value))
          context.report({ node, message: MESSAGE });
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => COMMAND_TEXT.test(quasi.value.cooked ?? "")))
          context.report({ node, message: MESSAGE });
      },
    };
  },
};

export const commandAutoApprovesAlchemy = (command) => COMMAND_TEXT.test(command);
