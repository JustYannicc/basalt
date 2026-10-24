import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubApi } from "./github.ts";
import type { ArtifactPin, PatchManifest } from "./types.ts";

const toolRepository = "UsefulSoftwareCo/executor";
const toolRepositoryUrl = "https://github.com/UsefulSoftwareCo/executor.git";
const homeRepository = "router-for-me/CLIProxyAPIHome";
const nodeRepository = "router-for-me/CLIProxyAPI";

export function createToolsSource(path: string): { repository: string; base: string; candidate: string; releaseTag: string; patch: string } {
  mkdirSync(join(path, "apps/hosted/cloud/src"), { recursive: true });
  writeFileSync(join(path, "apps/hosted/cloud/package.json"), '{"name":"@executor-js/hosted-cloud"}\n');
  writeFileSync(join(path, "apps/hosted/cloud/src/mode.ts"), 'export const mode = "upstream";\n');
  writeFileSync(join(path, "apps/hosted/cloud/src/version.ts"), 'export const release = "old";\n');
  git(path, ["init", "--initial-branch=main"]);
  configureGit(path);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture tools base"]);
  const base = git(path, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(path, "apps/hosted/cloud/src/version.ts"), 'export const release = "new";\n');
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture hosted cloud release"]);
  const candidate = git(path, ["rev-parse", "HEAD"]).trim();
  git(path, ["branch", "v2", candidate]);

  writeFileSync(join(path, "apps/hosted/cloud/src/mode.ts"), 'export const mode = "basalt";\n');
  const patch = git(path, ["diff", "--", "apps/hosted/cloud/src/mode.ts"]);
  git(path, ["checkout", "--", "apps/hosted/cloud/src/mode.ts"]);
  return { repository: path, base, candidate, releaseTag: "executor@2.0.0-beta.27", patch };
}

export function createHomeSource(path: string): { base: string; candidate: string; oauthSource: string } {
  const baseOAuthSource = `package management
import "strings"
func (c *Client) StartOAuthV8() {
  switch strings.ToLower(strings.TrimSpace(c.Query("provider"))) {
    case "claude":
  }
}`;
  mkdirSync(join(path, "internal/cluster/management"), { recursive: true });
  const sourcePath = join(path, "internal/cluster/management/oauth_v8.go");
  writeFileSync(sourcePath, baseOAuthSource);
  git(path, ["init", "--initial-branch=main"]);
  configureGit(path);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture Home release"]);
  const base = git(path, ["rev-parse", "HEAD"]).trim();
  const oauthSource = baseOAuthSource.replace("    case \"claude\":", "    case \"claude\":\n    case \"codex\":");
  writeFileSync(sourcePath, oauthSource);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture Home provider release"]);
  return { base, candidate: git(path, ["rev-parse", "HEAD"]).trim(), oauthSource };
}

export function createHomeAssets(path: string): Record<"amd64" | "arm64", { name: string; sha256: string }> {
  const version = "1.1.7";
  const assets = {
    amd64: { name: `CLIProxyAPIHome_${version}_linux_amd64_no-plugin.tar.gz`, sha256: "" },
    arm64: { name: `CLIProxyAPIHome_${version}_linux_aarch64_no-plugin.tar.gz`, sha256: "" },
  };
  mkdirSync(path, { recursive: true });
  for (const [architecture, asset] of Object.entries(assets)) {
    const bytes = Buffer.from(`fixture Home binary ${architecture} ${version}`);
    writeFileSync(join(path, asset.name), bytes);
    asset.sha256 = createHash("sha256").update(bytes).digest("hex");
  }
  return assets;
}

export function createBasaltFixture(path: string, toolBase: string, homeCommit: string, patch: string): string {
  mkdirSync(join(path, "patches"), { recursive: true });
  mkdirSync(join(path, "containers/pool"), { recursive: true });
  mkdirSync(join(path, "scripts/releases"), { recursive: true });
  mkdirSync(join(path, "src/pool"), { recursive: true });
  const home = artifact("home", "v1.1.6", homeCommit, "1");
  const node = artifact("node", "v8.0.40", "c".repeat(40), "2");
  writeFileSync(join(path, "upstream.json"), `${JSON.stringify({ repository: toolRepositoryUrl, commit: toolBase }, null, 2)}\n`);
  writeFileSync(join(path, "containers/pool/releases.json"), `${JSON.stringify({ format_version: 1, artifacts: { home, node } }, null, 2)}\n`);
  const manifest: PatchManifest = {
    format_version: 2,
    repository: toolRepository,
    patches: [{ file: "0001-fixture.patch", kind: "upstream", upstream_pull_request: null, database_sensitive: false, workflow_sensitive: false }],
  };
  writeFileSync(join(path, "scripts/releases/patches.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(path, "patches/0001-fixture.patch"), patch);
  writeFileSync(join(path, "src/pool/providers.json"), '[\n  {"id":"claude","name":"Claude"}\n]\n');
  writeFileSync(join(path, "README.md"), "simulation\n");
  git(path, ["init", "--initial-branch=main"]);
  configureGit(path);
  git(path, ["add", "."]);
  git(path, ["commit", "-m", "fixture pinned baseline"]);
  return path;
}

export function fixtureApi(
  toolsCommit: string,
  homeCommit: string,
  assets: Record<"amd64" | "arm64", { name: string; sha256: string }>,
  oauthSource: string,
): GitHubApi {
  const data = {
    tag_name: "v1.1.7",
    draft: false,
    prerelease: false,
    assets: Object.values(assets).map((asset) => ({ name: asset.name, digest: `sha256:${asset.sha256}` })),
  };
  return {
    async get(path: string) {
      if (path === `repos/${toolRepository}/releases?per_page=100&page=1`)
        return [{ tag_name: "executor@2.0.0-beta.27", draft: false }];
      if (path === `repos/${toolRepository}/commits/executor%402.0.0-beta.27`) return { sha: toolsCommit };
      if (path === `repos/${toolRepository}/contents/apps/hosted/cloud/package.json?ref=executor%402.0.0-beta.27`)
        return { encoding: "base64", content: Buffer.from('{"name":"@executor-js/hosted-cloud"}').toString("base64") };
      if (path === `repos/${homeRepository}/releases/latest`) return data;
      if (path === `repos/${homeRepository}/commits/v1.1.7`) return { sha: homeCommit };
      if (path === `repos/${homeRepository}/contents/internal/cluster/management/oauth_v8.go?ref=${homeCommit}`)
        return { encoding: "base64", content: Buffer.from(oauthSource).toString("base64") };
      const pull = /\/pulls\/(\d+)$/.exec(path);
      if (pull) return { merged: false, merge_commit_sha: null };
      throw new Error(`Unexpected simulated API path: ${path}`);
    },
    async compare() {
      return { complete: true, status: "diverged", aheadBy: 0, behindBy: 0, files: [] };
    },
  } as unknown as GitHubApi;
}

function artifact(kind: "home" | "node", tag: string, commit: string, digit: string): ArtifactPin {
  const prefix = kind === "home" ? "CLIProxyAPIHome" : "CLIProxyAPI";
  const version = tag.slice(1);
  const repository = kind === "home" ? homeRepository : nodeRepository;
  return {
    repository, tag, commit, binary: "cli-proxy-api",
    assets: {
      amd64: { name: `${prefix}_${version}_linux_amd64_no-plugin.tar.gz`, sha256: digit.repeat(64) },
      arm64: { name: `${prefix}_${version}_linux_aarch64_no-plugin.tar.gz`, sha256: digit.repeat(64) },
    },
  };
}

function configureGit(path: string): void {
  git(path, ["config", "user.name", "Release proof"]);
  git(path, ["config", "user.email", "release-proof@example.invalid"]);
}

function git(path: string, args: string[]): string {
  return execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
