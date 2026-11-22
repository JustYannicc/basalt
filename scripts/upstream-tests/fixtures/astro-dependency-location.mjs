import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

// The installed Astro, as the docs site builds with it.
const require = createRequire(
  new URL("../../../.upstream/apps/docs/package.json", import.meta.url),
);
const astroPackage = require.resolve("astro/package.json");
const { build } = await import(pathToFileURL(require.resolve("astro")).href);

// Real path: the bundler resolves through symlinks, and the temporary directory may be one.
const root = await realpath(await mkdtemp(join(tmpdir(), "astro-dependency-location-")));
const project = join(root, "project");
await mkdir(join(project, "src/pages"), { recursive: true });
await mkdir(join(project, "node_modules"), { recursive: true });
await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
await writeFile(
  join(project, "src/pages/index.astro"),
  '---\nimport Card from "fixture-card/Card.astro";\n---\n<Card />\n',
);
await symlink(join(astroPackage, ".."), join(project, "node_modules/astro"));

// One styled component, published from a package that sits in a dependency store.
const store = async (name) => {
  const pkg = join(root, name, "node_modules/.store/fixture-card@1.0.0/node_modules/fixture-card");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "fixture-card", type: "module" }),
  );
  await writeFile(
    join(pkg, "Card.astro"),
    '<p class="card">card</p>\n<style>.card { color: red; }</style>\n',
  );
  return pkg;
};

const files = async (directory) => {
  const out = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      out[relative(directory, path)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  return out;
};

// The same project, built once with the package in each store.
const outputs = [];
for (const name of ["first-install", "second-install-in-a-longer-store-path"]) {
  const link = join(project, "node_modules/fixture-card");
  await rm(link, { force: true });
  await symlink(await store(name), link);
  await rm(join(project, "dist"), { recursive: true, force: true });
  await rm(join(project, "node_modules/.astro"), { recursive: true, force: true });
  await build({ root: project, logLevel: "silent" });
  outputs.push(await files(join(project, "dist")));
}
await rm(root, { recursive: true, force: true });

assert.ok(Object.keys(outputs[0]).length > 0, "the build wrote its pages");
assert.deepEqual(
  outputs[1],
  outputs[0],
  "a dependency's store location leaves the built site unchanged",
);
