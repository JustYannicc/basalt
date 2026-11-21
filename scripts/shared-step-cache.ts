import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * One build step's outputs, shared by the jobs of one Check on the self-hosted box: the first job
 * builds under a lock, the others wait for its entry and restore it. Without a cache directory the
 * step builds as before. Upstream's `e2e:prepare` cache (carry 0722) uses the same lock design.
 */
export type SharedStep = {
  /** The cache directory, or undefined to build without one. */
  readonly cache: string | undefined;
  /**
   * Everything the outputs depend on; a different key never restores another's entry. Computed
   * only when a cache is named, so a failure computing it falls back to building too.
   */
  readonly key: () => string;
  readonly root: string;
  /** Paths under `root` that the build writes. */
  readonly outputs: readonly string[];
};

/** `$BASALT_BOX_SHARED/<name>/<run id>` on the box's CI runners; undefined anywhere else. */
export function sharedStepCache(name: string, env: NodeJS.ProcessEnv = process.env) {
  const shared = env.BASALT_BOX_SHARED;
  if (env.RUNNER_ENVIRONMENT !== "self-hosted" || !shared || !env.GITHUB_RUN_ID) return undefined;
  if (!existsSync(shared)) return undefined;
  return join(shared, name, env.GITHUB_RUN_ID);
}

/**
 * A key for a step that reads a Git worktree: the tree its tracked and unignored files form now
 * (through a temporary index, so the checkout's own index is untouched), with anything else the
 * step depends on.
 */
export function worktreeKey(directory: string, extra: Record<string, string>) {
  const index = join(tmpdir(), `basalt-step-index-${scratch}`);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: directory,
      env: { ...process.env, GIT_INDEX_FILE: index },
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  };
  try {
    git(["read-tree", "HEAD"]);
    git(["add", "-A"]);
    const tree = git(["write-tree"]);
    return createHash("sha256")
      .update(JSON.stringify({ tree, ...extra }))
      .digest("hex");
  } finally {
    rmSync(index, { force: true });
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const owner = `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2)}`;
// Box containers repeat process ids, so scratch names carry the whole owner token.
const scratch = owner.replace(/[^\w.-]/g, "_");
let held: string | undefined;
const release = () => {
  if (held === undefined) return;
  const lock = held;
  held = undefined;
  try {
    if (readFileSync(join(lock, "owner"), "utf8") === owner)
      rmSync(lock, { recursive: true, force: true });
  } catch {}
};
// A failed build exits through process.exit and an uncaught error exits too; both run this. A
// process killed by a signal leaves its lock, which is taken over once it is older than the bound.
process.on("exit", release);

/** Waits for the entry, or takes the lock: true to restore, false to build. */
function claim(entry: string, lock: string) {
  const stale = Number(process.env.BASALT_STEP_LOCK_STALE_MS) || 5 * 60_000;
  let waiting = false;
  for (;;) {
    if (existsSync(entry)) return true;
    // The lock appears with its owner already inside.
    const pending = `${lock}.${scratch}.pending`;
    mkdirSync(pending, { recursive: true });
    writeFileSync(join(pending, "owner"), owner);
    try {
      renameSync(pending, lock);
      held = lock;
      if (!existsSync(entry)) return false;
      release();
      return true;
    } catch (error) {
      rmSync(pending, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
    }
    if (!waiting) {
      console.log(`Waiting for another job's build: ${lock}`);
      waiting = true;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue;
    }
    if (age > stale) {
      console.log(`Taking over a lock held for ${Math.round(age / 1000)}s: ${lock}`);
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
      }
      continue;
    }
    sleep(500);
  }
}

export function withSharedStep(step: SharedStep, build: () => void) {
  if (!step.cache) return build();
  // The cache is an optimisation: if it fails (a full mount, an unreadable entry), the job
  // builds as it would without one.
  let restored: boolean;
  let key: string;
  try {
    key = step.key();
    restored = restoreOrClaim({ ...step, cache: step.cache }, key);
  } catch (error) {
    console.log(`Shared cache unavailable, building: ${(error as Error).message}`);
    release();
    return build();
  }
  if (restored) return;
  build();
  try {
    storeEntry({ ...step, cache: step.cache }, key);
  } catch (error) {
    console.log(`Shared cache not written: ${(error as Error).message}`);
  } finally {
    release();
  }
}

function restoreOrClaim(step: SharedStep & { readonly cache: string }, key: string) {
  const entry = join(step.cache, key);
  const lock = `${entry}.lock`;
  mkdirSync(step.cache, { recursive: true });
  if (!claim(entry, lock)) return false;
  for (const output of step.outputs) {
    rmSync(join(step.root, output), { recursive: true, force: true });
    mkdirSync(dirname(join(step.root, output)), { recursive: true });
    cpSync(join(entry, output), join(step.root, output), { recursive: true });
  }
  console.log(`Restored ${step.outputs.join(", ")} from ${entry}`);
  return true;
}

function storeEntry(step: SharedStep & { readonly cache: string }, key: string) {
  const entry = join(step.cache, key);
  // Written beside the entry and renamed, so a reader never sees a partial one.
  const partial = `${entry}.${scratch}.partial`;
  rmSync(partial, { recursive: true, force: true });
  for (const output of step.outputs) {
    mkdirSync(dirname(join(partial, output)), { recursive: true });
    cpSync(join(step.root, output), join(partial, output), { recursive: true });
  }
  try {
    renameSync(partial, entry);
  } catch {
    // Another job stored the same key first; its entry holds the same outputs.
    rmSync(partial, { recursive: true, force: true });
  }
}
