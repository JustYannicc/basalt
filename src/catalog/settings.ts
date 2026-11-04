import { servedFrameworkVersion } from "../../framework-release.ts";

/** Public feed configuration. App sources and credentials never enter the tools API bundle. */
export const catalog = {
  path: "/catalog/",
  official: "https://catalog.executor.sh/index.json",
  /**
   * The `apps` release Basalt's compiler serves from its own patched checkout. Every package the
   * feed serves declares it, so catalog apps build on Basalt's framework rather than a published one.
   */
  framework: servedFrameworkVersion,
} as const;
