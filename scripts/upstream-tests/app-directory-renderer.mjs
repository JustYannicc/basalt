import { createElement } from "../../.upstream/packages/ui/node_modules/react/index.js";
import { renderToString } from "../../.upstream/packages/ui/node_modules/react-dom/server.node.js";
import { RegistryProvider } from "../../.upstream/packages/ui/node_modules/@effect/atom-react/dist/index.js";
import { Atom, AsyncResult } from "effect/reactivity";
import { AppsPage } from "../../.upstream/packages/ui/src/implementation/dashboard/apps.tsx";
import { DashboardProvider } from "../../.upstream/packages/ui/src/implementation/dashboard/context.tsx";
import { noCatalogIcons } from "../../.upstream/packages/ui/src/contracts/icons.ts";

const input = JSON.parse(await Bun.stdin.text());
const inventory = {
  apps: input.apps,
  accounts: [],
  links: [],
};
const link = ({ children, className }) => createElement("a", { className }, children);
const tree = createElement(
  RegistryProvider,
  {},
  createElement(
    DashboardProvider,
    { catalogIcons: Atom.make(noCatalogIcons), AppLink: link, AccountLink: link },
    createElement(AppsPage, {
      query: Atom.make(AsyncResult.success(inventory)),
      Failure: () => {
        throw new Error("Directory renderer reached an unexpected failure");
      },
      connect: null,
    }),
  ),
);
process.stdout.write(renderToString(tree));
