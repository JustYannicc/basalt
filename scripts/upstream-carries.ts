import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { run } from "./process.ts";

/**
 * Bump whenever the replay changes how carries land: apply flags, the clean of added paths,
 * path validation or ordering. Trees recorded by another replay are then never served.
 */
export const REPLAY_VERSION = 1;

export type Carry = { name: string; bytes: Buffer };
type Pin = { repository: string; commit: string };

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Capture and restore bypass attributes and line-ending conversion, so a hit writes the replay's exact bytes.
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

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
// Bounded argument lists stay far below every platform's command-line limit.
const chunks = <A>(items: readonly A[]) =>
  Array.from({ length: Math.ceil(items.length / 256) }, (_, index) =>
    items.slice(index * 256, index * 256 + 256),
  );

// No git call here reads stdin: a synchronous child fed over a pipe has hung mid-replay.
function git(cwd: string, args: string[], env = process.env) {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `git ${args.find((arg) => /^[a-z][a-z-]*$/.test(arg))}: ${result.stderr.trim()}`,
    );
  return result.stdout;
}

/** Everything the replay's output depends on besides the checked-out pin itself. */
export function patchedTreeKey(
  upstream: string,
  pin: Pin,
  carries: readonly Carry[],
  replayVersion = REPLAY_VERSION,
) {
  const attributes = (name: string) => {
    const path = git(upstream, ["var", name]).trim();
    return existsSync(path) ? sha256(readFileSync(path)) : null;
  };
  return sha256(
    JSON.stringify([
      [pin.repository, pin.commit],
      carries.map(({ name, bytes }) => [name, sha256(bytes)]),
      replayVersion,
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

function replay(upstream: string, carries: readonly Carry[], files: readonly string[]) {
  carries.forEach(({ name, bytes }, index) => {
    const additions = [
      ...bytes.toString("utf8").matchAll(/--- \/dev\/null\n\+\+\+ b\/(.+)\n/g),
    ].map((match) => match[1]!);
    for (const added of additions) {
      if (added.startsWith("/") || added.split("/").includes(".."))
        throw new Error("Invalid patch path");
    }
    // Carries may replace a file another carry created earlier in the replay.
    if (additions.length) run("git", ["clean", "-f", "--", ...additions], upstream);
    try {
      run("git", ["apply", "--check", files[index]!], upstream);
      run("git", ["apply", files[index]!], upstream);
    } catch (error) {
      throw new Error(`Carry ${name} does not apply`, { cause: error });
    }
  });
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
    // Repository-wide attributes would still convert bytes during capture and restore.
    if (existsSync(join(common!, "info/attributes"))) return;
    index = path!;
    key = patchedTreeKey(upstream, pin, carries);
  } catch {
    return;
  }
  const ref = `refs/basalt/patched/${key}`;
  const subject = "Patched upstream tree";
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
      const stored = spawnSync("git", ["--git-dir", repository, "cat-file", "commit", ref], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
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
        scratchIndex((env) => {
          // A two-way merge from the pin writes only the paths the tree changes and refuses to clobber.
          git(upstream, [...RAW, "read-tree", "-m", "-u", pin.commit, tree], env);
          git(upstream, [...RAW, "diff-files", "--quiet"], env);
        });
        // The replay never moves HEAD or the index, and later preparation checks the pin.
        if (git(upstream, ["rev-parse", "HEAD"]).trim() !== pin.commit)
          throw new Error("HEAD left the pin");
        git(upstream, ["diff-index", "--cached", "--quiet", pin.commit]);
        console.log(`Restored the patched upstream tree for ${carries.length} carries.`);
        return true;
      } catch (error) {
        console.warn(
          `Patched upstream tree failed verification (${(error as Error).message}); replaying carries.`,
        );
        run("git", ["checkout", "--detach", "--force", pin.commit], upstream);
        run("git", ["clean", "-ffd", "--"], upstream);
        return false;
      }
    },
    async record(files: readonly string[], lock: (write: () => void) => Promise<unknown>) {
      try {
        // Config or environment that changed during the replay must not be recorded under the old key.
        if (patchedTreeKey(upstream, pin, carries) !== key) throw new Error("inputs changed");
        const commit = scratchIndex((env) => {
          // Apply names every path it writes; rename sources are tracked, so diff-files finds them.
          const touched = new Set(
            chunks(files).flatMap((group) =>
              git(upstream, ["apply", "--numstat", "-z", ...group])
                .split("\0")
                .filter(Boolean)
                .map((line) => line.split("\t").slice(2).join("\t")),
            ),
          );
          for (const path of git(upstream, [...RAW, "diff-files", "--name-only", "-z"], env)
            .split("\0")
            .filter(Boolean))
            touched.add(path);
          for (const group of chunks([...touched]))
            git(
              upstream,
              [...RAW, "update-index", "--add", "--remove", "--replace", "--", ...group],
              env,
            );
          const tree = git(upstream, ["write-tree"], env).trim();
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
      } catch (error) {
        console.warn(
          `Patched upstream tree was not recorded (${(error as Error).message}); the next preparation replays.`,
        );
      }
    },
  };
}

/** Leaves the carries applied to a checkout at the pin, with HEAD and the index still at the pin. */
export async function applyCarries(options: {
  upstream: string;
  repository: string;
  pin: Pin;
  patches: readonly string[];
  lock: (write: () => void) => Promise<unknown>;
}) {
  const { upstream, repository, pin } = options;
  const carries = options.patches.map((path) => ({
    name: basename(path),
    bytes: readFileSync(path),
  }));
  if (!carries.length) return "replayed" as const;
  const cache = patchedTree(upstream, repository, pin, carries);
  if (cache?.restore()) return "restored" as const;
  // Applying private copies of the hashed bytes keeps a recorded tree bound to its key.
  const directory = join(
    git(upstream, ["rev-parse", "--absolute-git-dir"]).trim(),
    "basalt-carries",
  );
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { mode: 0o700 });
  try {
    const files = carries.map(({ bytes }, index) => {
      const file = join(directory, `${String(index).padStart(5, "0")}.patch`);
      writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      return file;
    });
    replay(upstream, carries, files);
    await cache?.record(files, options.lock);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return "replayed" as const;
}
