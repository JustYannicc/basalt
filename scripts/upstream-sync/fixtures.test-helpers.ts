import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { serializePatchLayout } from "../releases/patch-layout.ts";
import type { PatchManifestV3 } from "../releases/types.ts";
import { git } from "./git.ts";
import { sha256 } from "./snapshot.ts";

export function commit(root: string) {
  git(root, ["add", "--all", "--force"]);
  git(root, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  ]);
  return git(root, ["rev-parse", "HEAD"]).trim();
}

export function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function change(file: string, before: string, after: string) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

export function addition(file: string, content: string) {
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${content}\n`;
}

export function syncFixture(context: TestContext, carries: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "basalt-sync-proof-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const objects = join(directory, "upstream");
  const root = join(directory, "basalt");
  for (const path of [objects, root]) {
    mkdirSync(path);
    git(path, ["init", "--quiet"]);
  }
  write(objects, "entry.txt", "base\n");
  write(objects, ".gitignore", "generated.txt\n");
  const target = commit(objects);
  const patches: PatchManifestV3["patches"] = Object.entries(carries).map(([file, content]) => ({
    identity: `sync-${file.replace(/\.patch$/, "")}`,
    file,
    content_sha256: sha256(content),
    kind: "overlay",
    upstream_pull_request: null,
    database_sensitive: false,
    workflow_sensitive: false,
  }));
  write(
    root,
    "upstream.json",
    JSON.stringify({ repository: "https://github.com/fixture/upstream.git", commit: target }),
  );
  for (const [path, content] of serializePatchLayout({
    format_version: 3,
    repository: "fixture/upstream",
    patches,
  }))
    write(root, path, String(content));
  for (const [file, content] of Object.entries(carries)) write(root, `patches/${file}`, content);
  return { directory, root, objects, target, candidate: commit(root) };
}
