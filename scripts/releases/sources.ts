import type { Architecture, ArtifactPin } from "./types.ts";
import { GitHubApi } from "./github.ts";

export type ToolCandidate = { repository: string; commit: string; tag: string };
export type ReleaseAsset = { name: string; digest?: string | null };
export type GitHubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
};
type GitHubReleaseList = { tag_name: string; draft: boolean };

export async function latestToolsCandidate(api: Pick<GitHubApi, "get">, repository: string): Promise<ToolCandidate> {
  const apiRepository = githubRepository(repository);
  const releases = await api.get<GitHubReleaseList[]>(`repos/${apiRepository}/releases?per_page=100&page=1`);
  const releasedV2 = releases
    .filter((release) => !release.draft && /^executor@2\./.test(release.tag_name))
    .map((release) => ({ release, version: parseVersion(release.tag_name.slice("executor@".length)) }))
    .filter((item): item is { release: GitHubReleaseList; version: Version } => item.version !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version));

  const release = releasedV2[0]?.release;
  if (!release) throw new Error("No published versioned Executor v2 release is available yet");
  const commit = await commitForTag(api, apiRepository, release.tag_name);
  await assertHostedCloudSource(api, apiRepository, release.tag_name);
  return { repository, commit, tag: release.tag_name };
}

async function assertHostedCloudSource(api: Pick<GitHubApi, "get">, repository: string, ref: string): Promise<void> {
  const path = `repos/${repository}/contents/apps/hosted/cloud/package.json?ref=${encodeURIComponent(ref)}`;
  const manifest = await api.get<{ encoding: string; content: string }>(path);
  if (manifest.encoding !== "base64") throw new Error("The Executor v2 release has no verifiable hosted cloud package");
  const packageJson = JSON.parse(Buffer.from(manifest.content, "base64").toString("utf8")) as { name?: string };
  if (packageJson.name !== "@executor-js/hosted-cloud")
    throw new Error("The Executor v2 release does not contain the hosted cloud service source");
}

export function githubRepository(value: string): string {
  const normalized = value
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized))
    throw new Error(`Expected a GitHub repository reference: ${value}`);
  return normalized;
}

export async function latestReleasedArtifact(
  api: Pick<GitHubApi, "get">,
  repository: string,
  kind: "home" | "node",
  current: ArtifactPin,
): Promise<ArtifactPin> {
  const release = await api.get<GitHubRelease>(`repos/${repository}/releases/latest`);
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.tag_name))
    throw new Error(`Expected a stable released version from ${repository}`);
  const version = release.tag_name.slice(1).split(/[+-]/, 1)[0]!;
  const prefix = kind === "home" ? "CLIProxyAPIHome" : "CLIProxyAPI";
  const assets = {} as Record<Architecture, { name: string; sha256: string }>;

  for (const [architecture, goArchitecture] of [["amd64", "amd64"], ["arm64", "aarch64"]] as const) {
    const expected = `${prefix}_${version}_linux_${goArchitecture}_no-plugin.tar.gz`;
    const matches = release.assets.filter((asset) => asset.name === expected);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${expected} release asset`);
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(matches[0]!.digest ?? "");
    if (!digest) throw new Error(`Missing immutable SHA-256 digest for ${expected}`);
    assets[architecture] = { name: expected, sha256: digest[1]!.toLowerCase() };
  }

  const commit = await commitForTag(api, repository, release.tag_name);
  return { ...current, repository, tag: release.tag_name, commit, assets };
}

export function sameArtifact(a: ArtifactPin, b: ArtifactPin): boolean {
  return a.repository === b.repository && a.tag === b.tag && a.commit === b.commit && a.binary === b.binary &&
    a.assets.amd64.name === b.assets.amd64.name && a.assets.amd64.sha256 === b.assets.amd64.sha256 &&
    a.assets.arm64.name === b.assets.arm64.name && a.assets.arm64.sha256 === b.assets.arm64.sha256;
}

async function commitForTag(api: Pick<GitHubApi, "get">, repository: string, tag: string): Promise<string> {
  const response = await api.get<{ sha: string }>(`repos/${repository}/commits/${encodeURIComponent(tag)}`);
  if (!isSha(response.sha)) throw new Error(`Release ${tag} did not resolve to an immutable commit`);
  return response.sha;
}

function isSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}

type Version = { major: number; minor: number; patch: number; prerelease: string[] };

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareVersions(a: Version, b: Version): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(b.prerelease.length) - Number(a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return left.localeCompare(right);
  }
  return 0;
}
