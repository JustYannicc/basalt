import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { servedFrameworkProtocol, servedFrameworkVersion } from "../framework-release.ts";
import { PublishedAppFramework } from "../.upstream/packages/sdk/src/contracts/worker-build.ts";
import { frameworkIdentity } from "../.upstream/packages/sdk/src/implementation/framework-identity.ts";
import { approvedFrameworkReleases } from "../.upstream/packages/sdk/src/implementation/basalt-framework-releases.ts";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Bind publication to the source and locked dependencies that produce its server and browser. */
export function frameworkSourceEvidence(upstream: string) {
  const paths = new Set(["package.json", "bun.lock", "bunfig.toml"]);
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(upstream, directory), { withFileTypes: true })) {
      if (["node_modules", "dist", ".git", ".generated"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) paths.add(path);
    }
  };
  for (const name of ["apps", "app-cache", "app-data", "telemetry", "utils"])
    visit(`packages/${name}`);
  const manifest = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8"));
  for (const patch of Object.values(manifest.patchedDependencies ?? {})) paths.add(String(patch));
  const source = {
    upstream: execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim(),
    files: [...paths].sort().map((path) => [path, sha256(readFileSync(join(upstream, path)))]),
  };
  return { revision: `source-sha256:${sha256(JSON.stringify(source))}`, source };
}

/** This gate compares publication with reviewed constants; a build never approves its own bytes. */
export async function builtFrameworkEvidence(root: string) {
  const upstream = join(root, ".upstream");
  const bytes = readFileSync(join(upstream, "packages/apps/dist/runtime.json"));
  const published = Schema.decodeUnknownSync(Schema.fromJsonString(PublishedAppFramework))(
    bytes.toString("utf8"),
  );
  if (published.version !== servedFrameworkVersion || published.protocol !== servedFrameworkProtocol)
    throw new Error(
      `Published framework ${published.version}/p${published.protocol} differs from ${servedFrameworkVersion}/p${servedFrameworkProtocol}`,
    );
  const server = await Effect.runPromise(
    frameworkIdentity({ version: published.version, modules: published.server }),
  );
  const browser = await Effect.runPromise(
    frameworkIdentity({ version: published.version, modules: published.browser }),
  );
  const source = frameworkSourceEvidence(upstream);
  return {
    ...server,
    protocol: published.protocol,
    browserSha256: browser.sha256,
    source: { origin: "basalt" as const, revision: source.revision, sha256: sha256(bytes) },
  };
}

export async function checkFrameworkProvenance(root: string) {
  const actual = await builtFrameworkEvidence(root);
  const approved = approvedFrameworkReleases.filter((release) => release.version === actual.version);
  if (approved.length !== 1 || JSON.stringify(approved[0]) !== JSON.stringify(actual))
    throw new Error(
      `Framework ${actual.version}/p${actual.protocol} publication differs from its approved server, browser or source identity: ${JSON.stringify({ approved, actual })}`,
    );
  return actual;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  console.log(JSON.stringify(await checkFrameworkProvenance(root)));
}
