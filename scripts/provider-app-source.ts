import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { servedFrameworkVersion } from "../framework-release.ts";

export const providerAppLabs = [
  "openai",
  "anthropic",
  "gemini",
  "vertex",
  "antigravity",
  "kimi",
  "xai",
  "devin",
  "meta",
  "jev",
  "cloudflare",
  "openrouter",
] as const;

/** Copy the canonical declaration unchanged so apps, saved accounts and pools share an identity. */
export function providerAppSource(root: string, lab: (typeof providerAppLabs)[number]) {
  return {
    package: `provider-${lab}`,
    files: [
      {
        path: "index.ts",
        content: `import { defineApp } from "apps";\nimport { providers } from "./providers.ts";\n\nexport const requirements = { app: { accounts: { ${lab}: providers.${lab}.many().requiring("model-inference") } } };\n\nexport default defineApp(requirements, {});\n`,
      },
      {
        path: "package.json",
        content: `${JSON.stringify({ name: `provider-${lab}`, private: true, type: "module", dependencies: { apps: servedFrameworkVersion } }, null, 2)}\n`,
      },
      {
        path: "providers.ts",
        content: readFileSync(join(root, "src/pool/provider-accounts/definitions.ts"), "utf8"),
      },
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const lab of providerAppLabs) {
    const file = join(root, `src/catalog/provider-apps/${lab}.json`);
    const content = `${JSON.stringify(providerAppSource(root, lab), null, 2)}\n`;
    if (process.argv.includes("--write")) writeFileSync(file, content);
    else if (readFileSync(file, "utf8") !== content)
      throw new Error(
        `Regenerate ${lab} provider app with node scripts/provider-app-source.ts --write`,
      );
  }
}
