import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const releaseOnlyDependencies = ["dugite", "electron"];

export const checkRuntimeEnvironment = (upstream: string) => ({
  // Electron's import otherwise downloads a missing binary before returning its path.
  ELECTRON_OVERRIDE_DIST_PATH: join(upstream, "node_modules/electron/dist"),
});

export function omitReleaseLifecycles(directory: string) {
  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  if (!releaseOnlyDependencies.some((name) => Object.hasOwn(dependencies, name))) return;
  if (!Array.isArray(manifest.trustedDependencies))
    throw new Error("CI release-download policy requires explicit trusted dependencies");
  const retained = (dependencies: string[]) =>
    dependencies.filter((name) => !releaseOnlyDependencies.includes(name));
  manifest.trustedDependencies = retained(manifest.trustedDependencies);
  const lockPath = join(directory, "bun.lock");
  const lock = readFileSync(lockPath, "utf8");
  let matched = false;
  const updated = lock.replace(/("trustedDependencies":\s*)\[([^\]]*)\]/, (_, prefix, entries) => {
    matched = true;
    const dependencies = JSON.parse(`[${entries.replace(/,\s*$/, "")}]`);
    return prefix + JSON.stringify(retained(dependencies));
  });
  if (!matched) throw new Error("CI release-download policy requires locked trusted dependencies");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(lockPath, updated);
}
