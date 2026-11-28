import { compilePrograms, recordEffectDiagnostics } from "./effect-diagnostics-record.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const compiler = ".upstream/node_modules/.bin/tsc-rs";
// Resource declarations use the same module and optional-property semantics as the upstream stack.
// The emulated upstream stage deploys its own stack and Worker, each with a config of its own.
const configs = [
  "tsconfig.json",
  "tsconfig.stack.json",
  "tsconfig.worker.json",
  "scripts/emulated-upstream/tsconfig.stack.json",
  "scripts/emulated-upstream/tsconfig.worker.json",
];
// The fast gate reads public source exports; the production gate checks the shipped declarations.
// Each bundled app with a browser screen has its own config over the same React and apps types.
for (const name of ["pool", "obsidian"]) {
  if (!process.argv.includes("--source")) {
    configs.push(`tsconfig.${name}.json`);
    continue;
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const apps = join(root, ".upstream/packages/apps");
  const manifest = JSON.parse(readFileSync(join(apps, "package.json"), "utf8"));
  const base = JSON.parse(readFileSync(join(root, `tsconfig.${name}.json`), "utf8"));
  const pool = JSON.parse(readFileSync(join(root, "tsconfig.pool.json"), "utf8"));
  const inherited = Object.fromEntries(
    Object.entries({ ...pool.compilerOptions.paths, ...base.compilerOptions?.paths }).map(
      ([entry, paths]) => [entry, (paths as string[]).map((path) => join(root, path))],
    ),
  );
  const paths = {
    ...inherited,
    ...Object.fromEntries(
      Object.entries(manifest.exports)
        .filter(([entry, source]) => typeof source === "string" && !entry.endsWith(".json"))
        .map(([entry, source]) => [
          entry === "." ? "apps" : "apps" + entry.slice(1),
          [join(apps, String(source))],
        ]),
    ),
  };
  delete paths["apps/*"];
  const config = join(root, `.generated/ci/${name}-source.json`);
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(
    config,
    JSON.stringify({ extends: join(root, `tsconfig.${name}.json`), compilerOptions: { paths } }),
  );
  configs.push(config);
}
recordEffectDiagnostics(await compilePrograms(compiler, [configs.slice(0, 1), configs.slice(1)]));
