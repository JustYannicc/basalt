import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareUpstreamCheckout } from "./upstream-cache.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

test("preparation removes a dropped carry's source and replays the current carry set", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-upstream-orphans-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  process.env.BASALT_UPSTREAM_CACHE = join(directory, "cache");
  t.after(() => {
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
  });
  const repository = join(directory, "repository");
  mkdirSync(repository);
  git(repository, "init", "-q");
  writeFileSync(join(repository, "pinned.ts"), "export const pinned = true;\n");
  writeFileSync(join(repository, ".gitignore"), "dist/\nnode_modules/\n.local/\n");
  git(repository, "add", ".");
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "Pin",
  );
  const pin = { repository, commit: git(repository, "rev-parse", "HEAD") };
  const root = join(directory, "checkout");
  const upstream = join(root, ".upstream");
  const carry = (name: string) => {
    const patch = join(directory, `${name}.patch`);
    writeFileSync(
      patch,
      `diff --git a/packages/${name}.ts b/packages/${name}.ts\nnew file mode 100644\n--- /dev/null\n+++ b/packages/${name}.ts\n@@ -0,0 +1 @@\n+export const ${name} = true;\n`,
    );
    return patch;
  };
  const dropped = carry("dropped"),
    retained = carry("retained");
  await prepareUpstreamCheckout(upstream, pin, [dropped, retained]);
  assert.equal(existsSync(join(upstream, "packages/dropped.ts")), true);
  assert.equal(existsSync(join(upstream, "packages/retained.ts")), true);
  for (const path of ["dist", "node_modules", ".local"]) {
    mkdirSync(join(upstream, path), { recursive: true });
    writeFileSync(join(upstream, path, "sentinel"), path);
  }
  writeFileSync(join(root, "outside.ts"), "outside the prepared checkout");
  writeFileSync(join(upstream, "pinned.ts"), "stale tracked source");
  rmSync(dropped);
  await prepareUpstreamCheckout(upstream, pin, [retained]);
  assert.equal(existsSync(join(upstream, "packages/dropped.ts")), false);
  assert.equal(
    readFileSync(join(upstream, "packages/retained.ts"), "utf8"),
    "export const retained = true;\n",
  );
  assert.equal(readFileSync(join(upstream, "pinned.ts"), "utf8"), "export const pinned = true;\n");
  assert.equal(readFileSync(join(root, "outside.ts"), "utf8"), "outside the prepared checkout");
  assert.equal(existsSync(retained), true);
  for (const path of ["dist", "node_modules", ".local"])
    assert.equal(readFileSync(join(upstream, path, "sentinel"), "utf8"), path);
  await prepareUpstreamCheckout(upstream, pin, []);
  assert.equal(git(upstream, "ls-files", "--others", "--exclude-standard"), "");
  assert.equal(git(upstream, "diff", "--name-only", pin.commit), "");
});

test("preparation never follows an untracked link or a linked upstream root outside the checkout", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-upstream-boundary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  process.env.BASALT_UPSTREAM_CACHE = join(directory, "cache");
  t.after(() => {
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
  });
  const repository = join(directory, "repository");
  mkdirSync(repository);
  git(repository, "init", "-q");
  writeFileSync(join(repository, "pinned.ts"), "pinned source\n");
  git(repository, "add", ".");
  git(
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "Pin",
  );
  const pin = { repository, commit: git(repository, "rev-parse", "HEAD") };
  const upstream = join(directory, "checkout/.upstream");
  await prepareUpstreamCheckout(upstream, pin);
  const outside = join(directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.ts"), "outside source\n");
  symlinkSync(outside, join(upstream, "orphan-link"), "dir");
  const nested = join(upstream, "orphan-repository");
  mkdirSync(nested);
  git(nested, "init", "-q");
  writeFileSync(join(nested, "orphan.ts"), "untracked nested source\n");
  await prepareUpstreamCheckout(upstream, pin);
  assert.equal(existsSync(join(upstream, "orphan-link")), false);
  assert.equal(existsSync(nested), false);
  assert.equal(readFileSync(join(outside, "keep.ts"), "utf8"), "outside source\n");
  const linked = join(directory, "linked/.upstream");
  mkdirSync(join(directory, "linked"));
  symlinkSync(repository, linked, "dir");
  writeFileSync(join(repository, "pinned.ts"), "outside edits must survive\n");
  await assert.rejects(prepareUpstreamCheckout(linked, pin), /must not be a symbolic link/);
  assert.equal(lstatSync(linked).isSymbolicLink(), true);
  assert.equal(readFileSync(join(repository, "pinned.ts"), "utf8"), "outside edits must survive\n");
});
