import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { poolFrameworkVersion } from "./pool-app-bundle.ts";

export const recipeRoles = ["operator", "pool-owner", "personal"] as const;
const names = {
  operator: "Production checks",
  "pool-owner": "My pool checks",
  personal: "My connection checks",
};
export function recipeSource(
  root: string,
  role: (typeof recipeRoles)[number],
  version = poolFrameworkVersion,
) {
  const files: Array<{ path: string; content: string }> = [];
  for (const directory of ["common", role]) {
    for (const entry of readdirSync(join(root, "recipes", directory), { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile())
        throw new Error("Recipe source must contain ordinary files.");
      if (!entry.name.endsWith(".ts")) continue;
      const rootIndex = directory === role && entry.name === "index.ts";
      let content = readFileSync(join(root, "recipes", directory, entry.name), "utf8");
      if (rootIndex) {
        content = content.replaceAll('"../common/', '"./common/');
        if (role === "operator") content = content.replace('"./reads.ts"', '"./operator/reads.ts"');
      }
      files.push({ path: rootIndex ? "index.ts" : `${directory}/${entry.name}`, content });
    }
  }
  files.push(
    {
      path: "migrations/0001_checkpoints.sql",
      content: readFileSync(join(root, "recipes/common/migration.sql"), "utf8"),
    },
    { path: "README.md", content: readFileSync(join(root, "recipes/README.md"), "utf8") },
    {
      path: "package.json",
      content: `${JSON.stringify({ name: `checks-${role}`, private: true, type: "module", executor: { title: names[role] }, dependencies: { apps: version } }, null, 2)}\n`,
    },
  );
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { package: `checks-${role}`, files };
}
export function writeRecipeSources(root: string) {
  for (const role of recipeRoles)
    writeFileSync(
      join(root, "src/catalog/recipes", `${role}.json`),
      `${JSON.stringify(recipeSource(root, role), null, 2)}\n`,
    );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (process.argv.slice(2).join(" ") !== "--write")
    throw new Error("Use --write to update the catalog's ordinary recipe sources.");
  writeRecipeSources(root);
}
