import { spawnSync } from "node:child_process";

export function gitResult(root: string, args: string[], input?: string | Buffer) {
  const result = spawnSync("git", args, {
    cwd: root,
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr?.toString("utf8") ?? "",
  };
}

export function git(root: string, args: string[], input?: string | Buffer) {
  const result = gitResult(root, args, input);
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.toString("utf8");
}

export function resolveCommit(root: string, ref: string) {
  const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected an exact Git commit");
  return commit;
}

export function treeEntries(root: string, commit: string) {
  return git(root, ["ls-tree", "-r", "--full-tree", "-z", commit])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/s.exec(line);
      if (!match) throw new Error("Invalid Git tree entry");
      return { mode: match[1]!, type: match[2]!, oid: match[3]!, path: match[4]! };
    });
}

export function readBlobs(root: string, objects: string[]) {
  if (!objects.length) return [];
  const result = gitResult(root, ["cat-file", "--batch"], objects.join("\n") + "\n");
  if (result.status !== 0) throw new Error("Could not read pinned source objects");
  let offset = 0;
  return objects.map((oid) => {
    const end = result.stdout.indexOf(10, offset);
    const header = result.stdout.subarray(offset, end).toString("utf8");
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== oid) throw new Error("Pinned source object is not a blob");
    const start = end + 1;
    offset = start + Number(match[2]);
    if (result.stdout[offset++] !== 10) throw new Error("Truncated pinned source object");
    return result.stdout.subarray(start, offset - 1);
  });
}
