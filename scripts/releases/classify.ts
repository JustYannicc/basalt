import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { GitHubApi } from "./github.ts";
import { changedPatchFiles, isDatabasePath, mergeEvidence, nodeDatabasePathState, sourceEvidence, toolsDatabasePathState, toolsWorkflowPathState } from "./paths.ts";
import { classifyPatchChanges } from "./classify-patches.ts";
import { judgedByContent, localEvidence, type LocalContents } from "./local-impact.ts";
import {
  assertPatchManifestContentMatchesFiles,
  assertPatchManifestMatchesFiles,
  parsePatchManifest,
} from "./patch-registry.ts";
import { githubRepository, sameArtifact } from "./sources.ts";
import type { ArtifactPin, ClassificationReport, Evidence, PatchManifestV3, ReleasePins, SourceComparison } from "./types.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type ClassificationInput = {
  baseGitCommit: string;
  candidateGitCommit: string;
  basePins: ReleasePins;
  candidatePins: ReleasePins;
  toolsComparison?: SourceComparison;
  homeComparison?: SourceComparison;
  nodeComparison?: SourceComparison;
  localChangedPaths?: string[];
  basePatchManifest?: PatchManifestV3;
  candidatePatchManifest?: PatchManifestV3;
  patchContents?: Record<string, { base?: string | Uint8Array; candidate?: string | Uint8Array }>;
  /** Changed Basalt files the local rules read, at both commits; empty where a file is absent. */
  localContents?: LocalContents;
};


export async function classifyRefs(
  repositoryRoot: string,
  baseRef: string,
  candidateRef: string,
  api: Pick<GitHubApi, "compare" | "compareTrees"> = new GitHubApi(),
): Promise<ClassificationReport> {
  const baseGitCommit = resolveCommit(repositoryRoot, baseRef);
  const candidateGitCommit = resolveCommit(repositoryRoot, candidateRef);
  const basePins = readPinsAt(repositoryRoot, baseGitCommit);
  const candidatePins = readPinsAt(repositoryRoot, candidateGitCommit);
  const localChangedPaths = git(repositoryRoot, ["diff", "--name-only", "--no-renames", baseGitCommit, candidateGitCommit]).trim().split("\n").filter(Boolean);
  const basePatchManifest = readManifestAt(repositoryRoot, baseGitCommit);
  const candidatePatchManifest = readManifestAt(repositoryRoot, candidateGitCommit);
  const patchContents: ClassificationInput["patchContents"] = {};

  for (const path of changedPatchFiles(localChangedPaths)) {
    const file = path.slice("patches/".length);
    patchContents[file] = {
      base: readOptionalBytesAt(repositoryRoot, baseGitCommit, path),
      candidate: readOptionalBytesAt(repositoryRoot, candidateGitCommit, path),
    };
  }

  const toolsComparison = basePins.tools.commit === candidatePins.tools.commit
    ? { complete: true, files: [] }
    : basePins.tools.repository === candidatePins.tools.repository
      ? await compareSourceSnapshots(api, githubRepository(basePins.tools.repository), basePins.tools.commit, candidatePins.tools.commit)
      : undefined;
  const homeComparison = basePins.home.commit === candidatePins.home.commit
    ? { complete: true, files: [] }
    : basePins.home.repository === candidatePins.home.repository
      ? await compareSourceSnapshots(api, basePins.home.repository, basePins.home.commit, candidatePins.home.commit)
      : undefined;
  const nodeComparison = basePins.node.commit === candidatePins.node.commit
    ? { complete: true, files: [] }
    : basePins.node.repository === candidatePins.node.repository
      ? await compareSourceSnapshots(api, basePins.node.repository, basePins.node.commit, candidatePins.node.commit)
      : undefined;

  return classifySnapshots({
    baseGitCommit,
    candidateGitCommit,
    basePins,
    candidatePins,
    toolsComparison,
    homeComparison,
    nodeComparison,
    localChangedPaths,
    basePatchManifest,
    candidatePatchManifest,
    patchContents,
    localContents: Object.fromEntries(localChangedPaths.filter(judgedByContent).map((path) => [path, {
      base: readOptionalAt(repositoryRoot, baseGitCommit, path) ?? "",
      candidate: readOptionalAt(repositoryRoot, candidateGitCommit, path) ?? "",
    }])),
  });
}

export function classifySnapshots(input: ClassificationInput): ClassificationReport {
  const dbSources: Evidence["sources"] = [];
  const workflowSources: Evidence["sources"] = [];
  const { basePins, candidatePins } = input;

  if (basePins.tools.commit !== candidatePins.tools.commit) {
    dbSources.push(sourceEvidence("tools", basePins.tools.commit, candidatePins.tools.commit, input.toolsComparison, (file) => toolsDatabasePathState(file.filename)));
    workflowSources.push(sourceEvidence("tools", basePins.tools.commit, candidatePins.tools.commit, input.toolsComparison, toolsWorkflowPathState));
  }

  const homeChanged = !sameArtifact(basePins.home, candidatePins.home);
  if (homeChanged) {
    const knownDatabasePaths = input.homeComparison?.files.filter((file) => isDatabasePath(file.filename)).map((file) => file.filename) ?? [];
    const state = knownDatabasePaths.length ? "changed" : "unknown";
    dbSources.push({
      name: "home",
      state,
      base: basePins.home.commit,
      candidate: candidatePins.home.commit,
      changedPaths: knownDatabasePaths.length ? knownDatabasePaths : input.homeComparison?.files.map((file) => file.filename) ?? [],
      reason: knownDatabasePaths.length
        ? undefined
        : "Home may change GORM AutoMigrate through model types or call sites; no source proof excludes it",
    });
  }

  if (!sameArtifact(basePins.node, candidatePins.node)) {
    if (basePins.node.commit === candidatePins.node.commit) {
      dbSources.push({
        name: "node",
        state: "unknown",
        base: basePins.node.commit,
        candidate: candidatePins.node.commit,
        changedPaths: [],
        reason: "node release metadata or binaries changed without a source commit change",
      });
    } else {
      dbSources.push(sourceEvidence("node", basePins.node.commit, candidatePins.node.commit, input.nodeComparison, (file) => nodeDatabasePathState(file.filename)));
    }
  }

  const local = localEvidence(input.baseGitCommit, input.candidateGitCommit, input.localChangedPaths ?? [], input.localContents);
  dbSources.push(...local.database);
  workflowSources.push(...local.workflow);

  const patchEvidence = classifyPatchChanges(input);
  if (patchEvidence.database) dbSources.push(patchEvidence.database);
  if (patchEvidence.workflow) workflowSources.push(patchEvidence.workflow);

  const database = mergeEvidence(dbSources);
  const workflow = mergeEvidence(workflowSources);
  return {
    schemaVersion: 1,
    base: { gitCommit: input.baseGitCommit, pins: basePins },
    candidate: { gitCommit: input.candidateGitCommit, pins: candidatePins },
    databaseChanged: database.state !== "unchanged",
    workflowChanged: workflow.state !== "unchanged",
    evidence: { database, workflow },
  };
}

export async function compareSourceSnapshots(
  api: Pick<GitHubApi, "compare" | "compareTrees">,
  repository: string,
  base: string,
  candidate: string,
): Promise<SourceComparison | undefined> {
  try {
    const comparison = await api.compare(repository, base, candidate);
    if (comparison.complete) return comparison;
  } catch {
    // Exported upstream snapshots can contain the same source without shared commit history.
  }
  try { return await api.compareTrees(repository, base, candidate); }
  catch { return undefined; }
}

function readPinsAt(repositoryRoot: string, commit: string): ReleasePins {
  const upstream = JSON.parse(readAt(repositoryRoot, commit, "upstream.json")) as { repository: string; commit: string };
  const pool = JSON.parse(readAt(repositoryRoot, commit, "containers/pool/releases.json")) as {
    artifacts: Record<"home" | "node", ArtifactPin>;
  };
  for (const sha of [upstream.commit, pool.artifacts.home.commit, pool.artifacts.node.commit])
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error(`Invalid immutable source commit in ${commit}`);
  return { tools: upstream, home: pool.artifacts.home, node: pool.artifacts.node };
}

function readManifestAt(repositoryRoot: string, commit: string): PatchManifestV3 | undefined {
  const source = readOptionalAt(repositoryRoot, commit, "scripts/releases/patches.json");
  if (source === undefined) return undefined;
  const parsed = parsePatchManifest(source);
  if (parsed.format_version === 2) return undefined;
  const manifest = parsed;
  const rows = git(repositoryRoot, ["ls-tree", "-r", "--format=%(objectmode) %(path)", commit, "--", "patches"])
    .trim().split("\n").filter(Boolean).map((line) => {
      const separator = line.indexOf(" ");
      return { mode: line.slice(0, separator), path: line.slice(separator + 1) };
    });
  for (const { mode, path } of rows) {
    if (path.endsWith(".patch") && mode !== "100644" && mode !== "100755")
      throw new Error(`Carried patch is not a regular Git blob: ${path}`);
  }
  const files = rows.filter(({ path }) => path.endsWith(".patch"))
    .map(({ path }) => path.slice("patches/".length));
  assertPatchManifestMatchesFiles(manifest, files);
  const contentByFile = Object.fromEntries(manifest.patches.map(({ file }) => [
    file,
    gitBuffer(repositoryRoot, ["show", `${commit}:patches/${file}`]),
  ]));
  assertPatchManifestContentMatchesFiles(manifest, contentByFile);
  return manifest;
}

function resolveCommit(repositoryRoot: string, ref: string): string {
  const commit = git(repositoryRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error(`Could not resolve exact commit for ${ref}`);
  return commit;
}

function readAt(repositoryRoot: string, commit: string, path: string): string {
  return git(repositoryRoot, ["show", `${commit}:${path}`]);
}

function readOptionalAt(repositoryRoot: string, commit: string, path: string): string | undefined {
  return pathExistsAt(repositoryRoot, commit, path) ? readAt(repositoryRoot, commit, path) : undefined;
}

function readOptionalBytesAt(repositoryRoot: string, commit: string, path: string): Buffer | undefined {
  return pathExistsAt(repositoryRoot, commit, path) ? gitBuffer(repositoryRoot, ["show", `${commit}:${path}`]) : undefined;
}

function pathExistsAt(repositoryRoot: string, commit: string, path: string): boolean {
  return git(repositoryRoot, ["ls-tree", "-r", "--name-only", commit, "--", path])
    .trim().split("\n").filter(Boolean).includes(path);
}

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitBuffer(repositoryRoot: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
}

function parseArgs(args: string[]): { base: string; candidate: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const [key, inline] = args[index]!.split("=", 2);
    if (key !== "--base" && key !== "--candidate") continue;
    const value = inline ?? args[++index];
    if (!value) throw new Error(`Missing value for ${key}`);
    values.set(key, value);
  }
  const base = values.get("--base");
  const candidate = values.get("--candidate");
  if (!base || !candidate) throw new Error("Usage: node scripts/releases/classify.ts --base <commit> --candidate <commit>");
  return { base, candidate };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { base, candidate } = parseArgs(process.argv.slice(2));
    const report = await classifyRefs(root, base, candidate);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
