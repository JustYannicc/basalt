import type { ContainerApplication } from "alchemy/Cloudflare";
import { havePropsChanged } from "alchemy/Diff";
import { isAbsolute, resolve, sep } from "node:path";

const poolContext = `${sep}containers${sep}pool`;
const declaration = (props: ContainerApplication["Props"]) => {
  if (!("context" in props)) return props;
  return {
    ...props,
    // Release workflows check out the same source under different absolute roots.
    context:
      typeof props.context === "string" &&
      isAbsolute(props.context) &&
      resolve(props.context).endsWith(poolContext)
        ? poolContext
        : props.context,
  };
};

export const containerDeclarationChanged = (
  news: ContainerApplication["Props"],
  olds: ContainerApplication["Props"],
) => havePropsChanged(declaration(news), declaration(olds));

export function runtimeImageDeclaration(
  news: ContainerApplication["Props"],
  olds: ContainerApplication["Props"],
) {
  const source = (props: ContainerApplication["Props"]) =>
    Object.fromEntries(
      Object.entries(declaration(props)).filter(([key]) => key !== "context" && key !== "image"),
    );
  const valid = (props: ContainerApplication["Props"]) =>
    "context" in props
      ? typeof props.context === "string" &&
        isAbsolute(props.context) &&
        resolve(props.context).endsWith(poolContext)
      : "image" in props &&
        typeof props.image === "string" &&
        /^registry\.cloudflare\.com\/[^/]+\/.+@sha256:[a-f0-9]{64}$/u.test(props.image);
  return valid(news) && valid(olds) && !havePropsChanged(source(news), source(olds));
}
