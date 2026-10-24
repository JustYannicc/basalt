import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactPin, PatchManifestV3, ReleasePins } from "./types.ts";
import { sha256PatchContent } from "./patch-registry.ts";

export const sha = (digit: string) => digit.repeat(40);
export const digest = (digit: string) => digit.repeat(64);

export function artifact(kind: "home" | "node", tag: string, commit: string, digit: string): ArtifactPin {
  const prefix = kind === "home" ? "CLIProxyAPIHome" : "CLIProxyAPI";
  const version = tag.slice(1);
  return {
    repository: kind === "home" ? "router-for-me/CLIProxyAPIHome" : "router-for-me/CLIProxyAPI",
    tag,
    commit,
    binary: "cli-proxy-api",
    assets: {
      amd64: { name: `${prefix}_${version}_linux_amd64_no-plugin.tar.gz`, sha256: digest(digit) },
      arm64: { name: `${prefix}_${version}_linux_aarch64_no-plugin.tar.gz`, sha256: digest(digit) },
    },
  };
}

export function pins(): ReleasePins {
  return {
    tools: { repository: "UsefulSoftwareCo/executor", commit: sha("a") },
    home: artifact("home", "v1.1.6", sha("b"), "1"),
    node: artifact("node", "v8.0.40", sha("c"), "2"),
  };
}

export const patchManifest: PatchManifestV3 = {
  format_version: 3,
  repository: "UsefulSoftwareCo/executor",
  patches: [
    {
      identity: "executor-review",
      file: "0001-review.patch",
      content_sha256: sha256PatchContent(patchFixtureContent("0001-review.patch")),
      kind: "upstream",
      upstream_pull_request: 10,
      database_sensitive: false,
      workflow_sensitive: false,
    },
    {
      identity: "executor-workflow",
      file: "0004-workflow.patch",
      content_sha256: sha256PatchContent(patchFixtureContent("0004-workflow.patch")),
      kind: "upstream",
      upstream_pull_request: 14,
      database_sensitive: true,
      workflow_sensitive: true,
    },
  ],
};

export function patchFixtureContent(file: string): string {
  return `placeholder patch ${file}\n`;
}

export function makeReleaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "basalt-release-test-"));
  mkdirSync(join(root, "containers/pool"), { recursive: true });
  mkdirSync(join(root, "patches"), { recursive: true });
  mkdirSync(join(root, "scripts/releases"), { recursive: true });
  mkdirSync(join(root, "src/pool"), { recursive: true });
  const current = pins();
  writeFileSync(join(root, "upstream.json"), `${JSON.stringify(current.tools, null, 2)}\n`);
  writeFileSync(join(root, "containers/pool/releases.json"), `${JSON.stringify({
    format_version: 1,
    artifacts: { home: current.home, node: current.node },
  }, null, 2)}\n`);
  writeFileSync(join(root, "scripts/releases/patches.json"), `${JSON.stringify(patchManifest, null, 2)}\n`);
  writeFileSync(join(root, "src/pool/providers.json"), '[\n  {"id":"claude","name":"Claude"}\n]\n');
  for (const patch of patchManifest.patches) writeFileSync(join(root, "patches", patch.file), patchFixtureContent(patch.file));
  return root;
}

export function releases(kind: "home" | "node", version: string, digit: string) {
  const prefix = kind === "home" ? "CLIProxyAPIHome" : "CLIProxyAPI";
  return {
    tag_name: `v${version}`,
    prerelease: false,
    draft: false,
    assets: ["amd64", "aarch64"].map((arch) => ({
      name: `${prefix}_${version}_linux_${arch}_no-plugin.tar.gz`,
      digest: `sha256:${digest(digit)}`,
    })),
  };
}

export const oauthSource = `package management
import "strings"
func (c *Client) StartOAuthV8() {
  switch strings.ToLower(strings.TrimSpace(c.Query("provider"))) {
    case "claude":
    case "codex":
    case "gemini":
  }
}`;
