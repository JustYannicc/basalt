// Alchemy 2.0.0-beta.80's CLI flag `--yes` does more than approve the plan: it also sets
// updateStateStore, and a brief failure of the shared State store's /version probe then redeploys
// the store and rotates its token under production. Apply and destroy run in-process through the
// release entry with updateStateStore: false, so no command line may pass `--yes` to Alchemy.
// A file that names Alchemy as a command has every standalone `--yes`/`-y` reported, however the
// command is assembled (argument arrays, push, spread, concatenation or templates).
const NAMES_ALCHEMY = /(?:^|[\s"'`/])alchemy(?=[\s"'`]|$)/mu;
const AUTO_APPROVE = /(?:^|\s)(?:--yes|-y)(?=\s|$)/u;
const MESSAGE =
  "Alchemy's CLI --yes also sets updateStateStore and can redeploy the shared State store. Apply and destroy go through the release entry in-process with updateStateStore: false.";

export const noAlchemyAutoApprove = {
  meta: { type: "problem", docs: { description: MESSAGE } },
  create(context) {
    if (!NAMES_ALCHEMY.test(context.sourceCode.text)) return {};
    return {
      Literal(node) {
        if (typeof node.value === "string" && AUTO_APPROVE.test(node.value))
          context.report({ node, message: MESSAGE });
      },
      TemplateElement(node) {
        if (AUTO_APPROVE.test(node.value.cooked ?? node.value.raw))
          context.report({ node, message: MESSAGE });
      },
    };
  },
};

// Workflow steps and package scripts are plain command lines.
export const commandAutoApprovesAlchemy = (command) =>
  NAMES_ALCHEMY.test(command) && AUTO_APPROVE.test(command);
