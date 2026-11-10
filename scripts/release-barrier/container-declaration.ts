import type { ContainerApplication } from "alchemy/Cloudflare";
import { havePropsChanged } from "alchemy/Diff";
import { isAbsolute, resolve, sep } from "node:path";

const poolContext = `${sep}containers${sep}pool`;
const declaration = (props: ContainerApplication["Props"]) => ({
  ...props,
  // Release workflows check out the same source under different absolute roots.
  context:
    typeof props.context === "string" &&
    isAbsolute(props.context) &&
    resolve(props.context).endsWith(poolContext)
      ? poolContext
      : props.context,
});

export const containerDeclarationChanged = (
  news: ContainerApplication["Props"],
  olds: ContainerApplication["Props"],
) => havePropsChanged(declaration(news), declaration(olds));
