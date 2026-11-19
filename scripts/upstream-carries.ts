import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { run } from "./process.ts";

type Pin = { repository: string; commit: string };
type Carry = { name: string; bytes: Buffer; file: string };

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
// The replay's own code is an input, so one replay never serves a tree recorded by another.
const REPLAY_SOURCE = sha256(
  Buffer.concat(
    ["./upstream-carries.ts", "./upstream-cache.ts", "./process.ts"].map((path) =>
      readFileSync(new URL(path, import.meta.url)),
    ),
  ),
);
/** Marker files whose modification time records when each patched tree was last used. */
export const patchedTreeUse = (repository: string, key = "") =>
  join(repository, "basalt-patched", key);

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Building, vetoing and restoring bypass attributes and line-ending conversion, so a hit writes the replay's exact bytes.
const RAW = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.attributesFile=/dev/null",
  `--attr-source=${EMPTY_TREE}`,
];
// These steer prompts, transport, identity and diagnostics, never what apply writes.
const INERT =
  /^GIT_(?:TRACE|SSH|HTTP_|CURL_|AUTHOR_|COMMITTER_|EDITOR$|SEQUENCE_EDITOR$|PAGER$|ASKPASS$|TERMINAL_PROMPT$)/;
const IDENTITY = Object.fromEntries(
  ["AUTHOR", "COMMITTER"].flatMap((role) => [
    [`GIT_${role}_NAME`, "Basalt"],
    [`GIT_${role}_EMAIL`, "prepare@basalt.invalid"],
    [`GIT_${role}_DATE`, "@0 +0000"],
  ]),
);

// Bounded argument lists stay far below every platform's command-line limit.
const chunks = <A>(items: readonly A[]) =>
  Array.from({ length: Math.ceil(items.length / 256) }, (_, index) =>
    items.slice(index * 256, index * 256 + 256),
  );
const lines = (output: string) => output.split("\0").filter(Boolean);
const additions = (bytes: Buffer) =>
  [...bytes.toString("utf8").matchAll(/--- \/dev\/null\n\+\+\+ b\/(.+)\n/g)].map(
    (match) => match[1]!,
  );
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

// No git call here reads stdin: a synchronous child fed over a pipe has hung mid-replay.
function spawnGit(cwd: string, args: string[], env = process.env) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return result;
}

function git(cwd: string, args: string[], env = process.env) {
  const result = spawnGit(cwd, args, env);
  if (result.status !== 0)
    throw new Error(
      `git ${args.find((arg) => /^[a-z][a-z-]*$/.test(arg))}: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

/** Whether the worktree holds exactly the scratch index's bytes, modes and links. */
function matchesWorktree(upstream: string, env: NodeJS.ProcessEnv) {
  // Entries apply or read-tree wrote may lack stat data; refreshing compares their content instead.
  spawnGit(upstream, [...RAW, "update-index", "-q", "--refresh"], env);
  return spawnGit(upstream, [...RAW, "diff-files", "--quiet"], env).status === 0;
}

/** Everything the replay's output depends on besides the checked-out pin itself. */
export function patchedTreeKey(
  upstream: string,
  pin: Pin,
  carries: readonly { name: string; bytes: Buffer }[],
  replaySource = REPLAY_SOURCE,
) {
  const attributes = (name: string) => {
    const path = git(upstream, ["var", name]).trim();
    return existsSync(path) ? sha256(readFileSync(path)) : null;
  };
  return sha256(
    JSON.stringify([
      [pin.repository, pin.commit],
      carries.map(({ name, bytes }) => [name, sha256(bytes)]),
      replaySource,
      git(upstream, ["--version"]).trim(),
      // Apply reads whitespace, line-ending, filter and attribute settings from every config scope.
      sha256(git(upstream, ["config", "--list", "-z"])),
      attributes("GIT_ATTR_GLOBAL"),
      attributes("GIT_ATTR_SYSTEM"),
      Object.entries(process.env)
        .filter(([name]) => name.startsWith("GIT_") && !INERT.test(name))
        .sort(([a], [b]) => (a < b ? -1 : 1)),
      process.platform,
    ]),
  );
}

function replay(upstream: string, carries: readonly Carry[]) {
  for (const { name, bytes, file } of carries) {
    const added = additions(bytes);
    for (const path of added) {
      if (path.startsWith("/") || path.split("/").includes(".."))
        throw new Error("Invalid patch path");
    }
    // Carries may replace a file another carry created earlier in the replay.
    if (added.length) run("git", ["clean", "-f", "--", ...added], upstream);
    try {
      run("git", ["apply", "--check", file], upstream);
      run("git", ["apply", file], upstream);
    } catch (error) {
      throw new Error(`Carry ${name} does not apply`, { cause: error });
    }
  }
}

/** Applies every carry to the pin's index, so the tree comes from the carries alone. */
function carriedTree(upstream: string, carries: readonly Carry[], env: NodeJS.ProcessEnv) {
  const pinned = new Set(lines(git(upstream, ["ls-files", "-z"], env)));
  const created = new Set<string>();
  let pending: string[] = [];
  const flush = () => {
    for (const group of chunks(pending))
      git(upstream, [...RAW, "apply", "--cached", ...group], env);
    pending = [];
  };
  for (const { bytes, file } of carries) {
    // The replay cleans an untracked file before a carry creates it again; the index drops it likewise.
    const replaced = additions(bytes).filter((path) => created.has(path));
    if (replaced.length) {
      flush();
      git(upstream, ["update-index", "--force-remove", "--", ...replaced], env);
    }
    pending.push(file);
    for (const path of additions(bytes)) if (!pinned.has(path)) created.add(path);
  }
  flush();
  return git(upstream, ["write-tree"], env).trim();
}

function patchedTree(upstream: string, repository: string, pin: Pin, carries: readonly Carry[]) {
  let index: string, key: string;
  try {
    const [common, path] = git(upstream, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--git-path",
      "index",
    ])
      .trim()
      .split("\n");
    // Standalone legacy checkouts keep objects other checkouts cannot read.
    if (realpathSync(common!) !== realpathSync(repository)) return;
    // Repository-wide attributes would still convert bytes during building and restoring.
    if (existsSync(join(common!, "info/attributes"))) return;
    // Without file modes the veto cannot see a lost executable bit.
    if (spawnGit(upstream, ["config", "--bool", "core.fileMode"]).stdout.trim() === "false") return;
    index = path!;
    key = patchedTreeKey(upstream, pin, carries);
  } catch {
    return;
  }
  const ref = `refs/basalt/patched/${key}`;
  const subject = "Patched upstream tree";
  const used = () => {
    try {
      mkdirSync(patchedTreeUse(repository), { recursive: true });
      writeFileSync(patchedTreeUse(repository, key), "");
    } catch {
      // The marker only orders collection; a read-only cache still serves its trees.
    }
  };
  // A copy keeps the checkout's stat data, so only paths the carries touch are rewritten or rehashed.
  // A fixed name means an interrupted preparation leaves nothing behind that the next one keeps.
  const scratchIndex = <A>(use: (env: NodeJS.ProcessEnv) => A) => {
    const temporary = `${index}.basalt-patched`;
    copyFileSync(index, temporary);
    try {
      return use({ ...process.env, GIT_ATTR_NOSYSTEM: "1", GIT_INDEX_FILE: temporary });
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  return {
    restore() {
      const stored = spawnGit(repository, ["--git-dir", repository, "cat-file", "commit", ref]);
      if (stored.status !== 0) return false;
      try {
        const split = stored.stdout.indexOf("\n\n");
        const header = stored.stdout.slice(0, split).split("\n");
        const tree = header.find((line) => line.startsWith("tree "))?.slice(5) ?? "";
        const parents = header.filter((line) => line.startsWith("parent "));
        if (
          split < 0 ||
          stored.stdout.slice(split + 2) !== `${subject}\n\nkey ${key}\n` ||
          parents.length !== 1 ||
          parents[0] !== `parent ${pin.commit}`
        )
          throw new Error("recorded key or pin differs");
        git(upstream, ["cat-file", "-e", `${tree}^{tree}`]);
        // The replay refuses to create a carried file over an ignored one; the hit refuses alike.
        for (const path of lines(
          git(upstream, [
            "diff-tree",
            "-r",
            "-z",
            "--name-only",
            "--diff-filter=A",
            pin.commit,
            tree,
          ]),
        ))
          if (lstatSync(join(upstream, path), { throwIfNoEntry: false }))
            throw new Error(`${path} already exists`);
        scratchIndex((env) => {
          // A two-way merge from the pin writes only the paths the tree changes.
          git(upstream, [...RAW, "read-tree", "-m", "-u", pin.commit, tree], env);
          if (!matchesWorktree(upstream, env))
            throw new Error("restored files differ from the recorded tree");
        });
        // The replay never moves HEAD or the index, and later preparation checks the pin.
        if (git(upstream, ["rev-parse", "HEAD"]).trim() !== pin.commit)
          throw new Error("HEAD left the pin");
        git(upstream, ["diff-index", "--cached", "--quiet", pin.commit]);
        used();
        console.log(`Restored the patched upstream tree for ${carries.length} carries.`);
        return true;
      } catch (error) {
        console.warn(
          `Patched upstream tree failed verification (${reason(error)}); replaying carries.`,
        );
        run("git", ["checkout", "--detach", "--force", pin.commit], upstream);
        run("git", ["clean", "-ffd", "--"], upstream);
        return false;
      }
    },
    async record(lock: (write: () => void) => Promise<unknown>) {
      try {
        // Config or environment that changed during the replay must not be recorded under the old key.
        if (patchedTreeKey(upstream, pin, carries) !== key)
          throw new Error("inputs changed during the replay");
        const commit = scratchIndex((env) => {
          const tree = carriedTree(upstream, carries, env);
          // The worktree only vetoes: a byte, mode or file the carries did not produce blocks recording.
          if (!matchesWorktree(upstream, env))
            throw new Error("the worktree differs from the carries' tree");
          const [foreign] = lines(
            git(upstream, ["ls-files", "--others", "--exclude-standard", "-z"], env),
          );
          if (foreign) throw new Error(`${foreign} is not carried`);
          return git(
            upstream,
            [
              "commit-tree",
              "--no-gpg-sign",
              "-p",
              pin.commit,
              "-m",
              subject,
              "-m",
              `key ${key}`,
              tree,
            ],
            { ...process.env, ...IDENTITY },
          ).trim();
        });
        await lock(() => git(upstream, ["--git-dir", repository, "update-ref", ref, commit]));
        used();
      } catch (error) {
        console.warn(
          `Patched upstream tree was not recorded (${reason(error)}); the next preparation replays.`,
        );
      }
    },
  };
}

/**
 * Leaves the carries applied to a checkout at the pin, with HEAD and the index still at the pin.
 * The caller holds the checkout's lock, so no other preparation writes the worktree meanwhile.
 */
export async function applyCarries(options: {
  upstream: string;
  repository: string;
  pin: Pin;
  patches: readonly string[];
  lock: (write: () => void) => Promise<unknown>;
}) {
  const { upstream, repository, pin } = options;
  if (!options.patches.length) return "replayed" as const;
  // Applying private copies of the hashed bytes keeps a recorded tree bound to its key.
  const directory = join(
    git(upstream, ["rev-parse", "--absolute-git-dir"]).trim(),
    "basalt-carries",
  );
  const carries = options.patches.map((path, index) => ({
    name: basename(path),
    bytes: readFileSync(path),
    file: join(directory, `${String(index).padStart(5, "0")}.patch`),
  }));
  const cache = patchedTree(upstream, repository, pin, carries);
  if (cache?.restore()) return "restored" as const;
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  try {
    for (const { bytes, file } of carries) writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    replay(upstream, carries);
    await cache?.record(options.lock);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return "replayed" as const;
}
