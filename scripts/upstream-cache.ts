import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  unlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { run } from "./process.ts";
import { currentProcessOwner, processOwnerAlive } from "./process-owner.ts";

export const upstreamCache = () =>
  resolve(process.env.BASALT_UPSTREAM_CACHE ?? join(homedir(), ".cache/basalt/upstream"));
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Locks belong to the preparing process; a dead owner is recoverable after an interrupted install. */
export async function withCacheLock<A>(path: string, use: () => A | Promise<A>): Promise<A> {
  mkdirSync(dirname(path), { recursive: true });
  const token = JSON.stringify({ ...currentProcessOwner(), id: randomUUID() });
  while (true) {
    try {
      symlinkSync(token, path);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let prior: string;
      try {
        prior = readlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("Cache lock has an invalid owner record");
      }
      if (!processOwnerAlive(JSON.parse(prior))) {
        // Serialize recovery so two stale readers cannot remove a newly acquired lock.
        await withCacheLock(`${path}.recovery`, () => {
          try {
            if (readlinkSync(path) === prior) unlinkSync(path);
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
          }
        });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await use();
  } finally {
    if (readlinkSync(path) === token) unlinkSync(path);
  }
}

export async function prepareUpstreamCheckout(
  upstream: string,
  pin: { repository: string; commit: string },
) {
  const repository = join(upstreamCache(), "repositories", `${digest(pin.repository)}.git`);
  await withCacheLock(`${repository}.lock`, () => {
    if (!existsSync(repository)) {
      mkdirSync(dirname(repository), { recursive: true });
      run("git", ["init", "--bare", repository]);
      run("git", ["--git-dir", repository, "remote", "add", "origin", pin.repository]);
    }
    const present = spawnSync("git", [
      "--git-dir",
      repository,
      "cat-file",
      "-e",
      `${pin.commit}^{commit}`,
    ]);
    if (present.status !== 0)
      run("git", ["--git-dir", repository, "fetch", "--depth=1", "origin", pin.commit]);
    run("git", [
      "--git-dir",
      repository,
      "update-ref",
      `refs/basalt/pins/${pin.commit}`,
      pin.commit,
    ]);
    if (!existsSync(join(upstream, ".git"))) {
      if (existsSync(upstream) && readdirSync(upstream).length)
        throw new Error("Upstream directory has files but no Git metadata");
      rmSync(upstream, { recursive: true, force: true });
      run("git", ["--git-dir", repository, "worktree", "add", "--detach", upstream, pin.commit]);
    }
    // Existing standalone generated checkouts can keep their index and refs while sharing pinned objects.
    // New checkouts use a registered worktree; conversion never rewrites an owner's saved Git metadata.
    const git = join(upstream, ".git");
    if (existsSync(join(git, "objects"))) {
      mkdirSync(join(git, "objects/info"), { recursive: true });
      writeFileSync(join(git, "objects/info/alternates"), `${join(repository, "objects")}\n`);
      run("git", ["fetch", "--depth=1", repository, pin.commit], upstream);
      run("git", ["repack", "-a", "-d", "-l"], upstream);
    }
    run("git", ["checkout", "--detach", "--force", pin.commit], upstream);
  });
}
