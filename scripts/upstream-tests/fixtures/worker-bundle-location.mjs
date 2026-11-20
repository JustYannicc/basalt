import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

// beta.80's wildcard exports name directories; its published runtime files are siblings.
const tree = process.argv[2] ?? "lib";
assert.ok(tree === "src" || tree === "lib");
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const { WorkerBundle } = await load("Cloudflare/Workers/Sources/Rolldown");
const { AlchemyContext } = await load("AlchemyContext");

const scratch = mkdtempSync(join(tmpdir(), "worker-bundle-location-"));
const dependencyPath = "node_modules/.bun/fixture-dependency@1.0.0/node_modules/fixture-dependency";
// A checkout as a release job has it: the Worker's package, a source beside the package, and one
// dependency that an install put into a store directory of its own and linked into the package.
const checkout = (name, store, note = "first") => {
  const root = join(scratch, name);
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write("app/package.json", JSON.stringify({ name: "fixture-app", type: "module" }));
  write(
    "app/src/worker.ts",
    [
      'import { greeting } from "../../shared/greeting.ts";',
      'import { decorate } from "fixture-dependency";',
      "export default { fetch: () => new Response(decorate(greeting)) };",
      "",
    ].join("\n"),
  );
  // The note is a comment: it changes the source and nothing of the code built from it.
  write("shared/greeting.ts", `// ${note}\nexport const greeting = "hello";\n`);
  const dependency = join(scratch, store, dependencyPath);
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "fixture-dependency",
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }),
  );
  // A body the bundler cannot fold away, so the dependency's file is a source of the bundle.
  writeFileSync(
    join(dependency, "index.js"),
    [
      'import platform from "./platform.cjs";',
      "export const decorate = (text) =>",
      "  [...text].reverse().join(String(Date.now() % 2)) + platform.eol();",
      "",
    ].join("\n"),
  );
  // Requiring a built-in makes the bundler add a module of its own, which is not a file.
  writeFileSync(join(dependency, "platform.cjs"), 'exports.eol = () => require("node:os").EOL;\n');
  mkdirSync(join(root, "app/node_modules"), { recursive: true });
  symlinkSync(dependency, join(root, "app/node_modules/fixture-dependency"));
  return root;
};
const startedIn = process.cwd();
// The bundler resolves a module that is not a file against the directory the process runs in.
const build = (root, runFrom = root) =>
  Effect.runPromise(
    Effect.gen(function* () {
      process.chdir(runFrom);
      const bundler = yield* WorkerBundle;
      return yield* bundler.build({
        id: "Fixture",
        main: join(root, "app/src/worker.ts"),
        compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
        entry: { kind: "external" },
        stack: { name: "fixture", stage: "fixture" },
        extraOptions: undefined,
      });
    }).pipe(
      Effect.provideService(AlchemyContext, {
        dotAlchemy: join(root, "app/.alchemy"),
        dev: false,
        adopt: false,
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
const text = (file) =>
  typeof file.content === "string" ? file.content : Buffer.from(file.content).toString("utf8");
const named = (bundle) => Object.fromEntries(bundle.files.map((file) => [file.path, text(file)]));
const mapOf = (files) => {
  const [name] = Object.keys(files).filter((path) => path.endsWith(".map"));
  assert.ok(name, "the bundle carries a source map");
  return { name, sources: JSON.parse(files[name]).sources };
};

try {
  // Two jobs at one commit: another checkout directory, another depth, another store directory,
  // and a build started from another place.
  const firstRoot = checkout("one/checkout", "one/store/generations/aaaaaaaa");
  const first = await build(firstRoot);
  const second = await build(
    checkout("two/runner/work/checkout", "two/cache/store/generations/bbbbbbbb"),
    join(scratch, "two/runner"),
  );
  const one = named(first);
  const two = named(second);
  assert.deepEqual(Object.keys(one).sort(), Object.keys(two).sort());
  const map = mapOf(one);
  assert.deepEqual(
    map.sources.filter((source) => source.includes("generations") || source.includes(scratch)),
    [],
    "no source path names this machine's directories",
  );
  // A map's sources are read from the map's own folder, as the bundler writes them. A file of the
  // checkout stays where a reader finds it there; a dependency is named as if its store sat in the
  // Worker's package; a module that is not a file keeps its own name.
  const folder = join(firstRoot, "app/.alchemy/bundles/Fixture");
  assert.deepEqual(
    [...map.sources].sort(),
    [
      "../../../../shared/greeting.ts",
      `../../../${dependencyPath}/index.js`,
      `../../../${dependencyPath}/platform.cjs`,
      "../../../src/worker.ts",
      "builtin:esm-external-require-node:os",
    ].sort(),
  );
  for (const source of ["../../../../shared/greeting.ts", "../../../src/worker.ts"])
    assert.ok(existsSync(resolve(folder, source)), `${source} leads from the map to its file`);
  for (const path of Object.keys(one))
    assert.equal(one[path] === two[path], true, `${path} differs between the two checkouts`);
  assert.equal(first.hash, second.hash, "the provider's hash differs between the two checkouts");

  // Nothing is hidden. A changed comment leaves the code as it was, and still changes the map and
  // the hash: the hash covers the map, and the map carries every source's text.
  const changed = await build(
    checkout("three/checkout", "three/store/generations/cccccccc", "second"),
  );
  const three = named(changed);
  for (const path of Object.keys(one).filter((path) => path.endsWith(".js")))
    assert.equal(one[path], three[path], `${path} changed with a comment`);
  assert.notEqual(one[map.name], three[mapOf(three).name], "a changed source changes the map");
  assert.notEqual(first.hash, changed.hash, "a changed source changes the provider's hash");
  console.log(JSON.stringify({ files: Object.keys(one).length, sources: map.sources.length }));
} finally {
  process.chdir(startedIn);
  rmSync(scratch, { recursive: true, force: true });
}
