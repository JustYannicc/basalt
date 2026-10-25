import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const omitted = new Set(["node_modules", "dist", "tests", "__tests__", ".git"]);
export const isShipped = (name) => !/\.(test|spec)\.[^/]+$/.test(name);

export function directoryFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (omitted.has(entry.name) || !isShipped(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`App source must not contain symlinks: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const name = relative(root, path).split("\\").join("/");
        files.push(
          name.startsWith("ui/public/")
            ? { path: name, size: statSync(path).size }
            : { path: name, bytes: readFileSync(path) },
        );
      }
    }
  }
  walk(root);
  return files;
}

/** Every app directory and catalog source document participates, without an app-name list. */
export function discoverApps(root) {
  const apps = [];
  function walk(directory, catalog) {
    if (!existsSync(directory)) return;
    const entries = readdirSync(directory, { withFileTypes: true });
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      apps.push({ name: relative(root, directory), files: directoryFiles(directory) });
      return;
    }
    for (const entry of entries) {
      if (omitted.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`App discovery must not follow symlinks: ${path}`);
      if (entry.isDirectory()) walk(path, catalog);
      else if (catalog && entry.name.endsWith(".json")) {
        // Published baselines prove the carried diff; they are outside the deployed source set.
        if (entry.name.endsWith(".published.json")) continue;
        const document = JSON.parse(readFileSync(path, "utf8"));
        if (!Object.hasOwn(document, "files")) continue;
        if (!Array.isArray(document.files)) {
          if (Object.hasOwn(document, "package"))
            throw new Error(`Invalid source document: ${path}`);
          continue;
        }
        apps.push({
          name: relative(root, path),
          files: document.files.map((file) => {
            if (typeof file.path === "string" && typeof file.content === "string")
              return { path: file.path, bytes: Buffer.from(file.content) };
            if (
              typeof file.path === "string" &&
              file.path.startsWith("ui/public/") &&
              typeof file.object === "string" &&
              Number.isSafeInteger(file.size) &&
              file.size >= 0
            )
              return { path: file.path, size: file.size };
            throw new Error(`Expected complete source or a public asset object: ${path}`);
          }),
        });
      }
    }
  }
  const appRoot = join(root, "apps");
  if (existsSync(appRoot))
    for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
      if (omitted.has(entry.name)) continue;
      if (entry.isSymbolicLink())
        throw new Error(`App discovery must not follow symlinks: ${entry.name}`);
      if (entry.isDirectory()) {
        const directory = join(appRoot, entry.name);
        apps.push({ name: relative(root, directory), files: directoryFiles(directory) });
      }
    }
  walk(join(root, "src/catalog"), true);
  if (!apps.length) throw new Error("No app sources found");
  return apps;
}

export function exactVersion(version) {
  return (
    typeof version === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version,
    )
  );
}
