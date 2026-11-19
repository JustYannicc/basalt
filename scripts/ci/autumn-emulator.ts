/**
 * Builds the Autumn billing emulator that local Cloud e2e runs start on loopback (#642). It is test
 * tooling: nothing it builds ships. The released `@executor-js/emulate` 0.14.2 lacks Autumn routes
 * Cloud calls, so this builds one pinned commit of the same repository that package is published
 * from, with that repository's own frozen lockfile and package manager. A cache keyed by the commit
 * holds the result, so only a cache miss downloads anything. Once a release contains those routes,
 * the jobs install it from a lockfile instead (#1508).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveTar, downloadVerified } from "./verified-download.mjs";

interface Pin {
  readonly repository: string;
  readonly commit: string;
  readonly archive: { readonly url: string; readonly integrity: string };
  readonly pnpm: { readonly version: string; readonly url: string; readonly integrity: string };
}

/** Raise when the build recipe changes, so no job restores a build made the old way. */
const recipe = 1;

export function autumnEmulatorPin(): Pin {
  return JSON.parse(readFileSync(new URL("./autumn-emulator.json", import.meta.url), "utf8"));
}

/** Where a build lives under `root` and the cache key that names exactly that build. */
export function autumnEmulatorBuild(
  root: string,
  pin = autumnEmulatorPin(),
  platform = `${process.platform}-${process.arch}`,
  nodeMajor = process.versions.node.split(".")[0],
) {
  const directory = join(root, "basalt-autumn-emulator", pin.commit);
  return {
    directory,
    entry: join(directory, "source/packages/emulate/dist/index.js"),
    receipt: join(directory, "built.json"),
    key: `autumn-emulator-v${recipe}-${pin.commit}-pnpm${pin.pnpm.version}-${platform}-node${nodeMajor}`,
  };
}

const extract = (archive: string, into: string) => {
  mkdirSync(into, { recursive: true });
  execFileSync(archiveTar(), ["-xzf", archive, "--strip-components=1", "-C", into]);
};

function build(root: string, pin: Pin) {
  const target = autumnEmulatorBuild(root, pin);
  rmSync(target.directory, { recursive: true, force: true });
  const downloads = join(root, "basalt-autumn-emulator-downloads");
  const source = join(target.directory, "source");
  const sourceArchive = join(downloads, `${pin.commit}.tgz`);
  downloadVerified(pin.archive.url, pin.archive.integrity, sourceArchive);
  extract(sourceArchive, source);
  const pnpmArchive = join(downloads, `pnpm-${pin.pnpm.version}.tgz`);
  downloadVerified(pin.pnpm.url, pin.pnpm.integrity, pnpmArchive);
  const pnpm = join(downloads, `pnpm-${pin.pnpm.version}`);
  rmSync(pnpm, { recursive: true, force: true });
  extract(pnpmArchive, pnpm);
  const run = (args: string[]) =>
    execFileSync(process.execPath, [join(pnpm, "bin/pnpm.mjs"), ...args], {
      cwd: source,
      stdio: "inherit",
      env: { ...process.env, CI: "true", npm_config_update_notifier: "false" },
    });
  // Only the CLI and the workspace packages it bundles; the repository's other apps stay out.
  const selection = ["--filter", "@executor-js/emulate..."];
  run([
    "install",
    "--frozen-lockfile",
    "--store-dir",
    join(root, "basalt-autumn-emulator-store"),
    ...selection,
  ]);
  run([...selection, "run", "build"]);
  if (!existsSync(target.entry)) throw new Error("The emulate build produced no CLI entry point");
  writeFileSync(target.receipt, `${JSON.stringify({ commit: pin.commit, key: target.key })}\n`);
}

function main(mode: string | undefined) {
  const root = process.env.RUNNER_TEMP;
  if (!root) throw new Error("Expected the runner temp directory");
  const pin = autumnEmulatorPin();
  const target = autumnEmulatorBuild(root, pin);
  if (mode === "identify") {
    if (!process.env.GITHUB_OUTPUT) throw new Error("Expected action output path");
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${target.key}\npath=${target.directory}\n`);
  } else if (mode === "install") {
    const built = existsSync(target.receipt)
      ? JSON.parse(readFileSync(target.receipt, "utf8")).key === target.key
      : false;
    if (built)
      console.log(`Restored the Autumn emulator built from ${pin.repository}@${pin.commit}`);
    else build(root, pin);
    if (!existsSync(target.entry)) throw new Error("The Autumn emulator CLI is missing");
    if (process.env.GITHUB_ENV)
      appendFileSync(process.env.GITHUB_ENV, `BASALT_E2E_AUTUMN_EMULATOR=${target.entry}\n`);
    console.log(`Local Autumn emulator: ${pin.repository}@${pin.commit}`);
  } else throw new Error("Expected identify or install");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2]);
