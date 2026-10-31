import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { GitHubApi } from "./github.ts";
import { activePatchFiles, decidePatchRemovals, readPatchManifest } from "./patches.ts";
import { patchManifestPath, updatedManifest } from "./patch-registry.ts";
import { githubRepository, latestReleasedArtifact, latestToolsCandidate, sameArtifact } from "./sources.ts";
import { buildProviderTable, extractOAuthProviderIds, renderProviderTable, type PoolProvider } from "../pool-providers.ts";
import type { ArtifactPin, PatchRemovalReceipt, ReleasePins } from "./types.ts";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type UpdateSource = "tools" | "home" | "node";
export type PlannedFile = { path: string; content: string | null };
export type UpdatePlan = {
  schemaVersion: 1;
  source: UpdateSource;
  releaseKey: string;
  basePins: ReleasePins;
  candidatePins: ReleasePins;
  changedPaths: string[];
  patchDecisions: Awaited<ReturnType<typeof decidePatchRemovals>>;
  providerTableGenerationFailed?: true;
  files: PlannedFile[];
};

export async function planUpdate(rootPath: string, source: UpdateSource, api: Pick<GitHubApi, "get" | "compare">): Promise<UpdatePlan> {
  const upstreamPath = join(rootPath, "upstream.json");
  const poolPath = join(rootPath, "containers/pool/releases.json");
  const upstream = JSON.parse(readFileSync(upstreamPath, "utf8")) as { repository: string; commit: string };
  const pool = JSON.parse(readFileSync(poolPath, "utf8")) as PoolReleases;
  const manifest = readPatchManifest(rootPath);
  if (manifest.repository !== githubRepository(upstream.repository))
    throw new Error("Patch manifest repository does not match upstream.json");
  const basePins = releasePins(upstream, pool);
  const candidatePins = structuredClone(basePins);
  const files: PlannedFile[] = [];
  let releaseKey = "";
  let patchDecisions: UpdatePlan["patchDecisions"] = [];
  let providerTableGenerationFailed = false;
  let removedPatches: PatchRemovalReceipt[] = [];

  if (source === "tools") {
    const candidate = await latestToolsCandidate(api, upstream.repository);
    candidatePins.tools = { repository: candidate.repository, commit: candidate.commit };
    releaseKey = `tools-${slug(candidate.tag)}-${candidate.commit.slice(0, 12)}`;
    if (candidate.commit !== upstream.commit) {
      files.push({
        path: "upstream.json",
        content: `${JSON.stringify({ ...upstream, commit: candidate.commit }, null, 2)}\n`,
      });
    }

    patchDecisions = await decidePatchRemovals(manifest, activePatchFiles(rootPath), candidate.commit, api);
    const removed = patchDecisions.filter((decision) => decision.remove);
    const removedIdentities = new Set(removed.map((decision) => decision.identity));
    removedPatches = removed
      .map(({ identity, content_sha256 }) => ({ identity, content_sha256 }))
      .sort((left, right) => left.identity.localeCompare(right.identity));
    for (const patch of removed) files.push({ path: `patches/${patch.file}`, content: null });
    if (removed.length) {
      const updated = updatedManifest(manifest, removedIdentities);
      files.push({ path: patchManifestPath, content: `${JSON.stringify(updated, null, 2)}\n` });
    }
  } else {
    const kind = source;
    const current = pool.artifacts[kind];
    const next = await latestReleasedArtifact(api, current.repository, kind, current);
    candidatePins[kind] = next;
    const changed = !sameArtifact(next, current);
    releaseKey = `${kind}-${slug(next.tag)}`;
    if (changed) {
      const artifacts = { ...pool.artifacts, [kind]: next };
      files.push({
        path: "containers/pool/releases.json",
        content: `${JSON.stringify({ ...pool, artifacts }, null, 2)}\n`,
      });
      if (kind === "home") {
        try {
          const providers = await generateProviderTable(rootPath, api, next);
          files.push({ path: "src/pool/providers.json", content: providers });
        } catch {
          providerTableGenerationFailed = true;
        }
      }
    }
  }

  const changes = files.filter((file) => file.content === null || readFileSync(join(rootPath, file.path), "utf8") !== file.content);
  const changedPaths = changes.map((file) => file.path).sort();
  if (changes.length) {
    const receiptPath = `scripts/releases/receipts/${source}.json`;
    const receipt = {
      schemaVersion: 2,
      source,
      releaseKey,
      basePins,
      candidatePins,
      removedPatches,
    };
    const receiptContent = `${JSON.stringify(receipt, null, 2)}\n`;
    if (!existsSync(join(rootPath, receiptPath)) || readFileSync(join(rootPath, receiptPath), "utf8") !== receiptContent) {
      changes.push({ path: receiptPath, content: receiptContent });
      if (!changedPaths.includes(receiptPath)) changedPaths.push(receiptPath);
    }
  }
  return {
    schemaVersion: 1,
    source,
    releaseKey,
    basePins,
    candidatePins,
    changedPaths: changedPaths.sort(),
    patchDecisions,
    ...(providerTableGenerationFailed ? { providerTableGenerationFailed: true } : {}),
    files: changes,
  };
}

export function applyUpdatePlan(rootPath: string, plan: UpdatePlan): void {
  for (const file of plan.files) {
    const path = join(rootPath, file.path);
    if (file.content === null) unlinkSync(path);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, "utf8");
    }
  }
}

function releasePins(upstream: { repository: string; commit: string }, pool: PoolReleases): ReleasePins {
  return {
    tools: { repository: upstream.repository, commit: upstream.commit },
    home: pool.artifacts.home,
    node: pool.artifacts.node,
  };
}

async function generateProviderTable(rootPath: string, api: Pick<GitHubApi, "get">, home: ArtifactPin): Promise<string> {
  const path = `repos/${home.repository}/contents/internal/cluster/management/oauth_v8.go?ref=${encodeURIComponent(home.commit)}`;
  const file = await api.get<{ encoding: string; content: string }>(path);
  if (file.encoding !== "base64") throw new Error("Pinned Home provider source was not returned as base64");
  const source = Buffer.from(file.content, "base64").toString("utf8");
  const existing = JSON.parse(readFileSync(join(rootPath, "src/pool/providers.json"), "utf8")) as PoolProvider[];
  const ids = extractOAuthProviderIds(source);
  return renderProviderTable(buildProviderTable(ids, existing));
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, "");
}

type PoolReleases = {
  format_version: 1;
  artifacts: Record<"home" | "node", ArtifactPin>;
};

function cliSource(args: string[]): UpdateSource {
  const value = args.find((arg) => arg.startsWith("--source="))?.slice("--source=".length);
  if (value !== "tools" && value !== "home" && value !== "node") throw new Error("Usage: node scripts/releases/update.ts --source=tools|home|node [--write]");
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const source = cliSource(process.argv.slice(2));
    const token = process.env.RELEASE_UPDATE_TOKEN;
    if (!token) throw new Error("RELEASE_UPDATE_TOKEN is required for release discovery");
    const plan = await planUpdate(root, source, new GitHubApi(token));
    if (process.argv.includes("--write")) applyUpdatePlan(root, plan);
    process.stdout.write(`${JSON.stringify({ ...plan, files: undefined }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
