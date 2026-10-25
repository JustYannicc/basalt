import { fileURLToPath } from "node:url";

/** Same rules for every app; only browser code has the browser's HTTP implementation. */
export function appConfig(entryFile = "index.ts") {
  return {
    categories: { correctness: "off" },
    plugins: [],
    jsPlugins: [
      { name: "executor-apps", specifier: fileURLToPath(new URL("./plugin.mjs", import.meta.url)) },
    ],
    rules: {
      "eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "effect",
                "effect/**",
                "@effect/**",
                "@executor/**",
                "@executor-js/**",
                "apps/effect",
                "apps/**/effect",
                "@executor.sh/sdk",
                "@executor.sh/sdk/**",
                "@usefulsoftware/executor-sdk",
                "@usefulsoftware/executor-sdk/**",
              ],
              message: "Use the apps framework; Effect and the Executor SDK belong to the host.",
            },
          ],
        },
      ],
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "Use ctx.fetch (or a destructured context fetch) so the host owns HTTP.",
        },
      ],
      "eslint/no-restricted-properties": [
        "error",
        { object: "globalThis", property: "fetch", message: "Use ctx.fetch." },
        { object: "window", property: "fetch", message: "Use ctx.fetch." },
        { object: "self", property: "fetch", message: "Use ctx.fetch." },
      ],
      "executor-apps/default-app-export": ["error", { entryFile }],
      "executor-apps/no-legacy-accounts": "error",
      "executor-apps/mutation-approval": "error",
    },
    overrides: [
      {
        files: ["**/ui/**"],
        rules: {
          "eslint/no-restricted-globals": "off",
          "eslint/no-restricted-properties": "off",
          "executor-apps/default-app-export": "off",
          "executor-apps/no-legacy-accounts": "off",
          "executor-apps/mutation-approval": "off",
        },
      },
    ],
  };
}
