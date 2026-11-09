import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function obsidianSource(root: string) {
  const directory = join(root, "apps/obsidian");
  const files: Array<{ path: string; content: string }> = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (["node_modules", "dist", "tests", "__tests__"].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Obsidian source must contain ordinary files.");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !/\.(test|spec)\.[^/]+$/.test(entry.name))
        files.push({
          path: relative(directory, path).split("\\").join("/"),
          content: readFileSync(path, "utf8"),
        });
    }
  };
  visit(directory);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { package: "obsidian", files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).join(" ") !== "--write")
    throw new Error("Use --write to update the Obsidian catalog source.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const destination = join(root, "src/catalog/obsidian/source.json");
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(obsidianSource(root), null, 2) + "\n");
}
