import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { digest, prepareUpstreamCheckout } from "./upstream-cache.ts";
import { collectPatchedTrees } from "./upstream-cache-gc.ts";
import { patchedTreeKey } from "./upstream-carries.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "basalt-carries-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  process.env.BASALT_UPSTREAM_CACHE = join(directory, "cache");
  t.after(() => {
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
  });
  const repository = join(directory, "repository");
  const write = (root: string, path: string, content: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (root: string) => {
    git(root, "add", "-A", "--force");
    git(
      root,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "c",
    );
  };
  mkdirSync(repository);
  git(repository, "init", "-q");
  write(repository, ".gitattributes", "*.txt text eol=lf\n");
  write(repository, ".gitignore", "node_modules/\nbuild/\n");
  write(repository, "pinned.ts", "export const pinned = 1;\n");
  write(repository, "tool.sh", "#!/bin/sh\necho tool\n");
  write(repository, "retired/old.ts", "export const old = true;\n");
  write(repository, "moved.ts", "export const moved = true;\n");
  write(repository, "notes.txt", "notes\n");
  commit(repository);
  const pin = { repository, commit: git(repository, "rev-parse", "HEAD") };
  // Carries come from Git's own diffs, so renames, modes and links use the real patch format.
  const authoring = join(directory, "authoring");
  git(directory, "clone", "-q", repository, authoring);
  const carry = (name: string, edit: () => void) => {
    edit();
    commit(authoring);
    const patch = join(directory, "patches", name);
    write(
      directory,
      `patches/${name}`,
      `${git(authoring, "diff", "--binary", "-M", "HEAD~1", "HEAD")}\n`,
    );
    return patch;
  };
  const edit = carry("0001-edit.patch", () => {
    write(authoring, "pinned.ts", "export const pinned = 2;\n");
    chmodSync(join(authoring, "tool.sh"), 0o755);
    rmSync(join(authoring, "retired"), { recursive: true });
    mkdirSync(join(authoring, "renamed"));
    renameSync(join(authoring, "moved.ts"), join(authoring, "renamed/moved.ts"));
    write(authoring, "packages/a.ts", "export const a = true;\n");
  });
  const links = carry("0002-links.patch", () => {
    symlinkSync("a.ts", join(authoring, "packages/link"));
    write(authoring, "packages/run.sh", "#!/bin/sh\necho run\n");
    chmodSync(join(authoring, "packages/run.sh"), 0o755);
    // A file the carried ignore rules hide must still be part of the recorded tree.
    write(authoring, "generated.ts", "export const generated = true;\n");
    write(authoring, ".gitignore", "node_modules/\nbuild/\ngenerated.ts\n");
  });
  // Checking in would normalize these line endings, so this carry is written by hand.
  const crlf = join(directory, "patches/0003-crlf.patch");
  writeFileSync(
    crlf,
    "diff --git a/crlf.txt b/crlf.txt\nnew file mode 100644\n--- /dev/null\n+++ b/crlf.txt\n@@ -0,0 +1,2 @@\n+one\r\n+two\r\n",
  );
  const cacheRepository = () =>
    join(directory, "cache/repositories", `${digest(pin.repository)}.git`);
  const refs = () =>
    existsSync(cacheRepository())
      ? git(cacheRepository(), "for-each-ref", "--format=%(refname)", "refs/basalt/patched/")
          .split("\n")
          .filter(Boolean)
      : [];
  const tree = (cache: string) =>
    git(
      cache,
      "rev-parse",
      `${git(cache, "for-each-ref", "--format=%(refname)", "refs/basalt/patched/")}^{tree}`,
    );
  return {
    directory,
    repository,
    pin,
    edit,
    links,
    crlf,
    cacheRepository,
    refs,
    tree,
    write,
    commit,
  };
}

const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

/** A git that runs `action` just before the replay checks the second carry. */
function gitShim(directory: string, name: string, action: string) {
  const bin = join(directory, "shims", name);
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\ncase "$1 $2 $3" in "apply --check "*00001.patch) ${action} ;; esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

function snapshot(upstream: string) {
  const entries: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === upstream && name === ".git") continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      const mode = (stat.mode & 0o170777).toString(8);
      const at = relative(upstream, path);
      if (stat.isSymbolicLink()) entries.push(`${at} ${mode} -> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) {
        entries.push(`${at} ${mode}`);
        walk(path);
      } else entries.push(`${at} ${mode} ${readFileSync(path).toString("base64")}`);
    }
  };
  walk(upstream);
  return {
    entries,
    head: git(upstream, "rev-parse", "HEAD"),
    index: git(upstream, "ls-files", "-s"),
    status: git(upstream, "status", "--porcelain", "--untracked-files=all", "--ignored"),
  };
}

test("a hit restores exactly what the replay left, and later preparation sees the pin", async (t) => {
  const { directory, pin, edit, links, crlf, refs } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  const carries = [edit, links, crlf];
  assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "replayed");
  assert.equal(refs().length, 1);
  mkdirSync(join(upstream, "node_modules"));
  writeFileSync(join(upstream, "node_modules/sentinel"), "installed");
  const replayed = snapshot(upstream);
  writeFileSync(join(upstream, "pinned.ts"), "stale edit\n");
  writeFileSync(join(upstream, "stray.ts"), "stray\n");
  assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "restored");
  const restored = snapshot(upstream);
  assert.deepEqual(restored, replayed);
  assert.equal(readFileSync(join(upstream, "crlf.txt"), "utf8"), "one\r\ntwo\r\n");
  assert.equal(lstatSync(join(upstream, "tool.sh")).mode & 0o111, 0o111);
  assert.equal(readlinkSync(join(upstream, "packages/link")), "a.ts");
  assert.equal(
    readFileSync(join(upstream, "generated.ts"), "utf8"),
    "export const generated = true;\n",
  );
  assert.equal(lstatSync(join(upstream, "moved.ts"), { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(join(upstream, "retired"), { throwIfNoEntry: false }), undefined);
  assert.equal(git(upstream, "rev-parse", "HEAD"), pin.commit);
  git(upstream, "diff", "--cached", "--quiet", pin.commit);
  assert.equal(refs().length, 1);

  const second = join(directory, "two/.upstream");
  assert.equal(await prepareUpstreamCheckout(second, pin, carries), "restored");
  mkdirSync(join(second, "node_modules"));
  writeFileSync(join(second, "node_modules/sentinel"), "installed");
  assert.deepEqual(snapshot(second), replayed);
});

test("every replay input selects its own recorded tree", async (t) => {
  const { directory, repository, pin, edit, links, crlf, refs, write, commit } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  const prepareTwice = async (target: typeof pin, carries: string[]) => {
    const before = refs().length;
    assert.equal(await prepareUpstreamCheckout(upstream, target, carries), "replayed");
    assert.equal(refs().length, before + 1);
    const replayed = snapshot(upstream);
    assert.equal(await prepareUpstreamCheckout(upstream, target, carries), "restored");
    assert.deepEqual(snapshot(upstream), replayed);
  };
  await prepareTwice(pin, [edit, links, crlf]);
  await prepareTwice(pin, [crlf, links, edit]);
  await prepareTwice(pin, [edit, links]);
  const extra = join(directory, "patches/0004-extra.patch");
  writeFileSync(
    extra,
    "diff --git a/extra.ts b/extra.ts\nnew file mode 100644\n--- /dev/null\n+++ b/extra.ts\n@@ -0,0 +1 @@\n+export const extra = true;\n",
  );
  await prepareTwice(pin, [edit, links, crlf, extra]);
  writeFileSync(crlf, readFileSync(crlf, "utf8").replace("+two", "+three"));
  await prepareTwice(pin, [edit, links, crlf]);
  assert.equal(readFileSync(join(upstream, "crlf.txt"), "utf8"), "one\r\nthree\r\n");
  write(repository, "unrelated.ts", "export const unrelated = true;\n");
  commit(repository);
  await prepareTwice({ repository, commit: git(repository, "rev-parse", "HEAD") }, [
    edit,
    links,
    crlf,
  ]);
});

test("the key covers patch bytes, set, order, pin, replay code, Git config and environment", async (t) => {
  const { directory, pin, edit, links, crlf } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  await prepareUpstreamCheckout(upstream, pin);
  const carries = [edit, links, crlf].map((path) => ({
    name: basename(path),
    bytes: readFileSync(path),
  }));
  const key = (overrides: { pin?: typeof pin; carries?: typeof carries; source?: string } = {}) =>
    patchedTreeKey(upstream, overrides.pin ?? pin, overrides.carries ?? carries, overrides.source);
  const base = key();
  assert.equal(key(), base);
  const edited = [...carries];
  edited[2] = { ...carries[2]!, bytes: Buffer.concat([carries[2]!.bytes, Buffer.from("\n")]) };
  const variants = [
    key({ carries: edited }),
    key({ carries: carries.slice(0, 2) }),
    key({ carries: [...carries, { name: "0004-extra.patch", bytes: Buffer.from("x") }] }),
    key({ carries: [carries[1]!, carries[0]!, carries[2]!] }),
    key({ carries: [{ ...carries[0]!, name: "0001-renamed.patch" }, ...carries.slice(1)] }),
    key({ pin: { ...pin, commit: "0".repeat(40) } }),
    key({ source: "another replay" }),
  ];
  git(upstream, "config", "apply.whitespace", "nowarn");
  variants.push(key());
  git(upstream, "config", "--unset", "apply.whitespace");
  assert.equal(key(), base);
  const previous = process.env.GIT_LITERAL_PATHSPECS;
  process.env.GIT_LITERAL_PATHSPECS = "1";
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
    else process.env.GIT_LITERAL_PATHSPECS = previous;
  });
  variants.push(key());
  delete process.env.GIT_LITERAL_PATHSPECS;
  assert.equal(new Set([base, ...variants]).size, variants.length + 1);
  const editor = process.env.GIT_EDITOR;
  process.env.GIT_EDITOR = "inert-editor";
  t.after(() => {
    if (editor === undefined) delete process.env.GIT_EDITOR;
    else process.env.GIT_EDITOR = editor;
  });
  assert.equal(key(), base);
});

test("a recorded tree that fails verification is replayed and recorded again", async (t) => {
  const { directory, pin, edit, links, crlf, cacheRepository, refs } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  const carries = [edit, links, crlf];
  await prepareUpstreamCheckout(upstream, pin, carries);
  const replayed = snapshot(upstream);
  const [ref] = refs();
  const recorded = git(cacheRepository(), "rev-parse", ref!);
  const repair = async (corrupt: () => void) => {
    corrupt();
    assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "replayed");
    assert.deepEqual(snapshot(upstream), replayed);
    assert.equal(git(cacheRepository(), "rev-parse", ref!), recorded);
    assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "restored");
  };
  await repair(() => git(cacheRepository(), "update-ref", ref!, `${recorded}^{tree}`));
  await repair(() => {
    const forged = execFileSync(
      "git",
      [
        "commit-tree",
        "-p",
        pin.commit,
        "-m",
        "Patched upstream tree",
        "-m",
        "key other",
        `${recorded}^{tree}`,
      ],
      {
        cwd: cacheRepository(),
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "x",
          GIT_AUTHOR_EMAIL: "x@example.test",
          GIT_COMMITTER_NAME: "x",
          GIT_COMMITTER_EMAIL: "x@example.test",
        },
      },
    ).trim();
    git(cacheRepository(), "update-ref", ref!, forged);
  });
  await repair(() => {
    // The added file's blob exists only in the recorded tree, so restoring must fail midway.
    const blob = git(cacheRepository(), "rev-parse", `${recorded}:packages/run.sh`);
    unlinkSync(join(cacheRepository(), "objects", blob.slice(0, 2), blob.slice(2)));
  });
});

test("standalone legacy checkouts replay without recording a tree they alone could read", async (t) => {
  const { directory, repository, pin, edit, refs } = fixture(t);
  const legacy = join(directory, "legacy/.upstream");
  git(directory, "clone", "-q", "--no-hardlinks", repository, legacy);
  assert.equal(await prepareUpstreamCheckout(legacy, pin, [edit]), "replayed");
  assert.equal(await prepareUpstreamCheckout(legacy, pin, [edit]), "replayed");
  assert.deepEqual(refs(), []);
});

test("concurrent preparations of one checkout record exactly a fresh replay's tree", async (t) => {
  const { directory, pin, edit, links, crlf, refs, tree, cacheRepository } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  const carries = [edit, links, crlf];
  const paused = join(directory, "paused"),
    release = join(directory, "release");
  const pausing = gitShim(
    directory,
    "pause",
    `: > '${paused}'; while [ ! -e '${release}' ]; do sleep 0.05; done`,
  );
  const prepare = (bin?: string) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const [module, upstream, pin, carries] = JSON.parse(process.env.BASALT_TEST_ARGS);" +
          "const { prepareUpstreamCheckout } = await import(module);" +
          "console.log(await prepareUpstreamCheckout(upstream, pin, carries));",
      ],
      {
        env: {
          ...process.env,
          PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH,
          BASALT_TEST_ARGS: JSON.stringify([
            new URL("./upstream-cache.ts", import.meta.url).href,
            upstream,
            pin,
            carries,
          ]),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => child.kill());
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    return new Promise<{ code: number | null; output: string }>((resolve) =>
      child.once("exit", (code) => resolve({ code, output })),
    );
  };
  const first = prepare(pausing);
  let exited = false;
  void first.then(() => (exited = true));
  while (!existsSync(paused) && !exited) await delay(20);
  assert.ok(existsSync(paused), "the first preparation must pause inside its replay");
  const second = prepare();
  // A second preparation that ignored the checkout lock would finish well within this bound.
  await Promise.race([second, delay(2000)]);
  writeFileSync(release, "");
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.code, 0, one.output);
  assert.equal(two.code, 0, two.output);
  assert.match(two.output, /^restored$/m);
  assert.equal(refs().length, 1);

  process.env.BASALT_UPSTREAM_CACHE = join(directory, "fresh-cache");
  const fresh = join(directory, "fresh/.upstream");
  assert.equal(await prepareUpstreamCheckout(fresh, pin, carries), "replayed");
  process.env.BASALT_UPSTREAM_CACHE = join(directory, "cache");
  assert.equal(
    tree(cacheRepository()),
    tree(join(directory, "fresh-cache/repositories", `${digest(pin.repository)}.git`)),
  );
  assert.deepEqual(snapshot(upstream), snapshot(fresh));
});

test("writes the carries did not make block recording", async (t) => {
  const { directory, pin, edit, links, crlf, refs } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  const carries = [edit, links, crlf];
  const path = process.env.PATH;
  t.after(() => (process.env.PATH = path));
  for (const target of ["notes.txt", "pinned.ts", "stray.ts"]) {
    const bin = gitShim(directory, target, `printf 'foreign\\n' >> '${join(upstream, target)}'`);
    process.env.PATH = `${bin}:${path}`;
    assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "replayed");
    assert.deepEqual(refs(), [], `a write to ${target} must not be recorded`);
  }
  process.env.PATH = path;
  assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "replayed");
  assert.equal(refs().length, 1);
  assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "restored");
  assert.equal(readFileSync(join(upstream, "notes.txt"), "utf8"), "notes\n");
  assert.equal(readFileSync(join(upstream, "pinned.ts"), "utf8"), "export const pinned = 2;\n");
  assert.equal(existsSync(join(upstream, "stray.ts")), false);
});

test("checkouts without file modes replay without recording", async (t) => {
  const { directory, pin, edit, refs } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  await prepareUpstreamCheckout(upstream, pin);
  git(upstream, "config", "core.fileMode", "false");
  assert.equal(await prepareUpstreamCheckout(upstream, pin, [edit]), "replayed");
  assert.equal(await prepareUpstreamCheckout(upstream, pin, [edit]), "replayed");
  assert.deepEqual(refs(), []);
  assert.equal(lstatSync(join(upstream, "tool.sh")).mode & 0o111, 0o111);
});

test("a hit refuses an ignored file at a carried path, as the replay does", async (t) => {
  const { directory, pin, edit, refs } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  const built = join(directory, "patches/0004-built.patch");
  writeFileSync(
    built,
    "diff --git a/build/out.js b/build/out.js\nnew file mode 100644\n--- /dev/null\n+++ b/build/out.js\n@@ -0,0 +1 @@\n+carried\n",
  );
  assert.equal(await prepareUpstreamCheckout(upstream, pin, [edit, built]), "replayed");
  assert.equal(refs().length, 1);
  writeFileSync(join(upstream, "build/out.js"), "built locally\n");
  await assert.rejects(
    prepareUpstreamCheckout(upstream, pin, [edit, built]),
    /Carry 0004-built\.patch does not apply/,
  );
  assert.equal(readFileSync(join(upstream, "build/out.js"), "utf8"), "built locally\n");
});

test("collection keeps the most recently used patched trees", async (t) => {
  const { directory, pin, edit, links, crlf, refs } = fixture(t);
  const upstream = join(directory, "one/.upstream");
  for (const carries of [[edit], [edit, links], [edit, links, crlf]])
    assert.equal(await prepareUpstreamCheckout(upstream, pin, carries), "replayed");
  assert.equal(await prepareUpstreamCheckout(upstream, pin, [edit]), "restored");
  collectPatchedTrees(2);
  assert.equal(refs().length, 2);
  assert.equal(await prepareUpstreamCheckout(upstream, pin, [edit]), "restored");
  assert.equal(await prepareUpstreamCheckout(upstream, pin, [edit, links, crlf]), "restored");
  assert.equal(await prepareUpstreamCheckout(upstream, pin, [edit, links]), "replayed");
});
