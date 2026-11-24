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

// The installed Vite+ and the dashboard's own build options, as the web app builds with them.
const web = new URL("../../../.upstream/apps/hosted/cloud/web/", import.meta.url);
const require = createRequire(new URL("package.json", web));
const { build, loadConfigFromFile } = await import(
  pathToFileURL(require.resolve("vite-plus")).href
);
const { reproducibleBuild } = await import(new URL("reproducible-build.ts", web).href);

// The dashboard's own config carries the options: removing them from it fails here.
const dashboard = await loadConfigFromFile(
  { command: "build", mode: "production" },
  new URL("vite.config.ts", web).pathname,
);
assert.equal(dashboard?.config.build?.rolldownOptions?.experimental?.attachDebugInfo, "none");

// Real path: the bundler resolves through symlinks, and the temporary directory may be one.
const root = await realpath(await mkdtemp(join(tmpdir(), "web-build-location-")));
const project = join(root, "project");
await mkdir(join(project, "node_modules"), { recursive: true });
await writeFile(join(project, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
await writeFile(
  join(project, "entry.js"),
  'import { greet } from "fixture-dep";\nexport const render = () => greet("server");\n',
);

// One dependency, installed into a store whose directory is new on every install.
const store = async (name) => {
  const pkg = join(root, name, "node_modules/.store/fixture-dep@1.0.0/node_modules/fixture-dep");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "fixture-dep", type: "module", exports: "./index.js" }),
  );
  await writeFile(join(pkg, "index.js"), "export const greet = (name) => `hello ${name}`;\n");
  return pkg;
};

const files = async (directory) => {
  const out = {};
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && !entry.name.endsWith(".map")) {
      const path = join(entry.parentPath, entry.name);
      out[relative(directory, path)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  return out;
};

// The same server build, once with the dependency in each store.
const twice = async (options) => {
  const outputs = [];
  for (const name of ["first-install", "second-install-in-a-longer-store-path"]) {
    const link = join(project, "node_modules/fixture-dep");
    await rm(link, { force: true });
    await symlink(await store(name), link);
    const outDir = join(project, "dist");
    await rm(outDir, { recursive: true, force: true });
    await build({
      root: project,
      logLevel: "silent",
      configFile: false,
      // The dashboard's server build bundles its dependencies, as a Worker needs.
      ssr: { noExternal: true },
      build: { ssr: "entry.js", outDir, minify: false, sourcemap: "hidden", ...options },
    });
    outputs.push(await files(outDir));
  }
  return outputs;
};

try {
  // Today's default names each module's location in the server build's code.
  const [plainFirst, plainSecond] = await twice({});
  assert.notDeepEqual(plainSecond, plainFirst, "the default build differs between stores");
  // The dashboard's options leave the code the same bytes, whatever the store.
  const [first, second] = await twice(reproducibleBuild);
  assert.ok(Object.keys(first).length > 0, "the build wrote its output");
  assert.deepEqual(
    second,
    first,
    "a dependency's store location leaves the server build unchanged",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
