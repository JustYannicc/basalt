import {
  readGitSource,
  type SourceFile,
  type GitHubSourceReader,
} from "./catalog-source-github.ts";
export type { SourceFile, GitHubSourceReader } from "./catalog-source-github.ts";
import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GitHubApi } from "./releases/github.ts";

import {
  createSourceArtifacts,
  updateSourceProvenance,
  isRecord,
  isSafeSourcePath,
} from "./catalog-source-artifacts.ts";
export {
  createSourceArtifacts,
  updateSourceProvenance,
  type SourceArtifacts,
} from "./catalog-source-artifacts.ts";
import { checkCatalogSources } from "./catalog-source-check.ts";

const sourceRepositories = {
  aws: "JustYannicc/signalbox-app-aws",
  atlassian: "JustYannicc/signalbox-app-atlassian",
  zendesk: "JustYannicc/signalbox-app-zendesk",
} as const;

export type CatalogPackage = keyof typeof sourceRepositories;

export type CatalogSourceApp = {
  package: CatalogPackage;
  repository: (typeof sourceRepositories)[CatalogPackage];
  commit: string;
  files: string[];
};

export type CatalogSourceManifest = {
  schema: 1;
  apps: CatalogSourceApp[];
};

export function parseCatalogSourceManifest(value: unknown): CatalogSourceManifest {
  if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.apps))
    throw new Error("Invalid catalog source manifest: expected schema 1 and an apps array");

  const apps: CatalogSourceApp[] = [];
  const seen = new Set<string>();
  for (const candidate of value.apps) {
    if (
      !isRecord(candidate) ||
      typeof candidate.package !== "string" ||
      !Object.hasOwn(sourceRepositories, candidate.package)
    )
      throw new Error("Invalid catalog source manifest: unknown package");
    const packageName = candidate.package as CatalogPackage;
    const repository = sourceRepositories[packageName];
    if (candidate.repository !== repository)
      throw new Error(`Invalid catalog source manifest: ${packageName} must use ${repository}`);
    if (typeof candidate.commit !== "string" || !/^[a-f0-9]{40}$/.test(candidate.commit))
      throw new Error(
        `Invalid catalog source manifest: ${packageName} needs a full lowercase 40 character commit SHA`,
      );
    if (seen.has(packageName))
      throw new Error(`Invalid catalog source manifest: duplicate ${packageName} entry`);
    seen.add(packageName);
    if (
      !Array.isArray(candidate.files) ||
      candidate.files.length === 0 ||
      !candidate.files.every(isSafeSourcePath)
    )
      throw new Error(
        `Invalid catalog source manifest: ${packageName} files must be a non-empty safe relative allowlist`,
      );
    if (new Set(candidate.files).size !== candidate.files.length)
      throw new Error(
        `Invalid catalog source manifest: ${packageName} file allowlist contains duplicates`,
      );
    if (!candidate.files.includes("package.json"))
      throw new Error(
        `Invalid catalog source manifest: ${packageName} must allowlist package.json`,
      );
    apps.push({
      package: packageName,
      repository,
      commit: candidate.commit,
      files: [...candidate.files],
    });
  }

  const expectedPackages = Object.keys(sourceRepositories).sort();
  if (seen.size !== expectedPackages.length || expectedPackages.some((name) => !seen.has(name)))
    throw new Error(`Invalid catalog source manifest: expected ${expectedPackages.join(", ")}`);
  return { schema: 1, apps };
}

export async function fetchPinnedSource(
  app: CatalogSourceApp,
  github: GitHubSourceReader,
): Promise<SourceFile[]> {
  if (
    !Object.hasOwn(sourceRepositories, app.package) ||
    sourceRepositories[app.package] !== app.repository ||
    !isGitSha(app.commit) ||
    !Array.isArray(app.files) ||
    app.files.length === 0 ||
    !app.files.every(isSafeSourcePath) ||
    new Set(app.files).size !== app.files.length ||
    !app.files.includes("package.json")
  )
    throw new Error("Invalid catalog source app pin or root-file allowlist");
  const files = await readGitSource(app.repository, app.commit, app.files, github);

  const packageFile = files.find((file) => file.path === "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageFile!.content);
  } catch {
    throw new Error(`${app.package} source package.json is not valid JSON`);
  }
  if (!isRecord(manifest) || manifest.name !== app.package)
    throw new Error(`${app.package} source package.json must keep the package name ${app.package}`);
  return files;
}

export async function runCatalogSources(options: {
  root: string;
  manifestPath?: string;
  write?: boolean;
  github?: GitHubSourceReader;
}): Promise<void> {
  const root = resolve(options.root);
  const manifestPath = resolve(root, options.manifestPath ?? "scripts/catalog-sources.json");
  const manifest = parseCatalogSourceManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  if (!options.write) {
    await checkCatalogSources(root, manifest);
    return;
  }
  const github = options.github ?? new GitHubApi();
  const updates = await Promise.all(
    manifest.apps.map(async (app) => {
      const sourceFiles = await fetchPinnedSource(app, github);
      const artifacts = createSourceArtifacts(app.package, sourceFiles);
      const sourcePath = join(root, "src/catalog", app.package, "source.json");
      const provenancePath = join(root, "src/catalog", app.package, "provenance.json");
      const currentProvenance = JSON.parse(await readFile(provenancePath, "utf8")) as unknown;
      if (!isRecord(currentProvenance))
        throw new Error(`${app.package} provenance must be a JSON object`);
      const provenance = updateSourceProvenance(currentProvenance, app, artifacts);
      return {
        packageName: app.package,
        sourcePath,
        source: artifacts.snapshot,
        provenancePath,
        provenance,
      };
    }),
  );

  const staged: Array<{ temporary: string; target: string }> = [];
  try {
    for (const update of updates) {
      for (const [target, content] of [
        [update.sourcePath, update.source],
        [update.provenancePath, update.provenance],
      ] as const) {
        const temporary = join(dirname(target), `.catalog-source-${randomUUID()}.tmp`);
        await writeFile(temporary, content, { flag: "wx" });
        staged.push({ temporary, target });
      }
    }
    for (const file of staged) await rename(file.temporary, file.target);
  } catch (error) {
    await Promise.all(staged.map((file) => unlink(file.temporary).catch(() => undefined)));
    throw error;
  }
}

function isGitSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function parseArgs(argv: string[]): { manifestPath?: string; write: boolean } {
  let manifestPath: string | undefined;
  let write = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--write") write = true;
    else if (argument === "--check") write = false;
    else if (argument === "--manifest") {
      const path = argv[++index];
      if (!path) throw new Error("--manifest requires a path");
      manifestPath = path;
    } else throw new Error(`Unknown catalog source argument: ${argument}`);
  }
  return { manifestPath, write };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await runCatalogSources({ root, ...args });
  console.log(
    args.write
      ? "Catalog source snapshots updated."
      : "Catalog source snapshots match their committed pins and hashes (offline).",
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
