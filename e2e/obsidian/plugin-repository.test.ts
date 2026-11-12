import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/obsidian-plugin-repository.sh", import.meta.url));
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

test("a build reaches the plugin repository once, in Obsidian's layout, and never changes", () => {
  const root = mkdtempSync(join(tmpdir(), "plugin-repository-"));
  try {
    // The plugin repository as it starts: an existing main branch.
    const remote = join(root, "remote.git");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    const seed = join(root, "seed");
    git(root, "clone", "--quiet", remote, seed);
    writeFileSync(join(seed, "README.md"), "Signalbox Sync\n");
    git(seed, "add", "README.md");
    git(seed, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "seed");
    git(seed, "push", "--quiet", "origin", "HEAD:refs/heads/main");

    const dist = join(root, "dist");
    mkdirSync(dist);
    const manifest = `${JSON.stringify({ id: "signalbox-sync", version: "9.9.1" })}\n`;
    writeFileSync(join(dist, "manifest.json"), manifest);
    writeFileSync(join(dist, "main.js"), "build one");
    writeFileSync(join(dist, "styles.css"), "css");
    const versions = join(root, "versions.json");
    writeFileSync(versions, `${JSON.stringify({ "9.9.1": "1.12.3" })}\n`);
    let run = 0;
    const publish = () =>
      spawnSync("bash", [script, remote, dist, versions, join(root, `work-${run++}`)], {
        encoding: "utf8",
      });

    const first = publish();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout.trim(), "pushed");
    const check = join(root, "check");
    git(root, "clone", "--quiet", remote, check);
    git(check, "fetch", "--quiet", "--tags");
    assert.equal(git(check, "show", "9.9.1:manifest.json") + "\n", manifest);
    assert.equal(git(check, "show", "9.9.1:dist/main.js"), "build one");
    assert.equal(git(check, "show", "9.9.1:dist/styles.css"), "css");
    assert.equal(git(check, "show", "9.9.1:versions.json") + "\n", readFileSync(versions, "utf8"));
    // The tag is on main, so main's root is what the community list and BRAT read.
    assert.equal(git(check, "rev-parse", "9.9.1^{commit}"), git(check, "rev-parse", "origin/main"));

    // A re-run of the same build changes nothing.
    const again = publish();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout.trim(), "existing");

    // Other bytes under a published version are refused, naming the file.
    writeFileSync(join(dist, "main.js"), "build two");
    const changed = publish();
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /already has 9\.9\.1 and its dist\/main\.js differs/);
    assert.equal(git(remote, "rev-parse", "refs/tags/9.9.1^{commit}"), git(check, "rev-parse", "9.9.1^{commit}"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
