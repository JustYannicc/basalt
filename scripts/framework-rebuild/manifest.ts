import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256, type RebuildInput } from "./input.ts";

function stringMap(value: unknown): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  )
    throw new Error("framework output is not a string map");
  return value as Record<string, string>;
}

export const moduleMapSha256 = (modules: Record<string, string>) =>
  sha256(
    JSON.stringify(
      Object.keys(modules)
        .sort()
        .map((name) => [name, modules[name]]),
    ),
  );

export function frameworkHashes(
  runtimeBytes: Buffer,
  packageBytes: Buffer,
  archiveRuntime: Buffer,
) {
  const runtime: unknown = JSON.parse(runtimeBytes.toString("utf8"));
  if (
    !runtime ||
    typeof runtime !== "object" ||
    !("version" in runtime) ||
    typeof runtime.version !== "string" ||
    !("protocol" in runtime) ||
    typeof runtime.protocol !== "number" ||
    !Number.isSafeInteger(runtime.protocol) ||
    runtime.protocol < 1 ||
    !("server" in runtime) ||
    !("browser" in runtime)
  )
    throw new Error("framework runtime identity is missing");
  const server = stringMap(runtime.server),
    browser = stringMap(runtime.browser);
  if (!Object.keys(server).length || !Object.keys(browser).length)
    throw new Error("framework runtime modules are empty");
  const files = stringMap(JSON.parse(packageBytes.toString("utf8")));
  if (
    files["runtime.json"] !== runtimeBytes.toString("utf8") ||
    !archiveRuntime.equals(runtimeBytes)
  )
    throw new Error("runtime bytes differ between build and package formats");
  const packageFiles = Object.keys(files)
    .sort()
    .map((name) => {
      if (name.startsWith("/") || name.split(/[\\/]/).some((part) => part === "." || part === ".."))
        throw new Error("package file name is not relative");
      const content = files[name]!;
      return { name, bytes: Buffer.byteLength(content), sha256: sha256(content) };
    });
  return {
    version: runtime.version,
    protocol: runtime.protocol,
    serverModuleMapSha256: moduleMapSha256(server),
    browserModuleMapSha256: moduleMapSha256(browser),
    runtimeSha256: sha256(runtimeBytes),
    packageFiles,
    declarations: packageFiles.filter((file) => file.name.endsWith(".d.ts")),
  };
}

export function hashManifest(root: string, input: RebuildInput, controllerCommit: string) {
  if (!/^[a-f0-9]{40}$/.test(controllerCommit))
    throw new Error("rebuild controller commit missing");
  const upstream = join(root, ".upstream");
  const file = (path: string) => readFileSync(join(upstream, path));
  const runtime = file("packages/apps/dist/runtime.json");
  const archivePath = join(upstream, ".local/test-runtime/apps.tgz");
  const archive = readFileSync(archivePath);
  const packed = file(".local/basalt-framework/framework.json");
  const archiveRuntime = execFileSync("tar", ["-xOf", archivePath, "package/runtime.json"], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const git = (directory: string, args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const sourceCommit = git(root, ["rev-parse", "HEAD"]).trim();
  if (sourceCommit !== input.commit || git(root, ["status", "--porcelain"]) !== "")
    throw new Error("historical source changed during framework build");
  const sources = [
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "packages/apps/package.json",
    "packages/apps/scripts/build.mjs",
    "scripts/build-basalt-framework.ts",
  ].map((name) => {
    const bytes = file(name);
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  return {
    format: "basalt-framework-rebuild-hashes-v1",
    status: "built",
    request: input,
    producer: {
      controllerCommit,
      sourceCommit,
      upstreamCommit: git(upstream, ["rev-parse", "HEAD"]).trim(),
      node: process.version,
      bun: input.bun,
      platform: process.platform,
      arch: process.arch,
      imageOS: process.env.ImageOS,
      imageVersion: process.env.ImageVersion,
    },
    framework: frameworkHashes(runtime, packed, archiveRuntime),
    bundles: [
      { name: "runtime.json", bytes: runtime.length, sha256: sha256(runtime) },
      { name: "apps.tgz", bytes: archive.length, sha256: sha256(archive) },
      { name: "framework.json", bytes: packed.length, sha256: sha256(packed) },
    ],
    sources,
    preparedDiffSha256: sha256(git(upstream, ["diff", "--binary"])),
    sourceRestoredBeforeBuild: true,
    runtimeBytesEqualAcrossPackages: true,
    outputNormalization: false,
  };
}
