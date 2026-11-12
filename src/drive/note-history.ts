import { DriveError } from "./shared/.generated/strata/errors.js";
import { parseCommit, parseTree } from "./shared/.generated/strata/git/objects.js";
import type { GitObject } from "./shared/strata/types.ts";

type Read = (oid: string) => Promise<GitObject | null>;

export interface NoteVersion {
  readonly oid: string;
  readonly parents: readonly string[];
  readonly message: string;
  /** When the server wrote the commit, as an ISO time. Every commit has one, old ones included. */
  readonly time: string;
}

/** A walk never reads more than this many commits, so one request stays bounded. */
const scanLimit = 5000;
const isoTime = (seconds: number) => new Date(seconds * 1000).toISOString();

/**
 * Versions of the vault, or of one note, read from the vault object's own clone. A note version is
 * a commit whose content at that path differs from every parent's, so a merge appears only when it
 * changed the note itself; the commits on either side appear on their own. The walk mirrors
 * strata's own history, which has no path filter.
 */
export function noteHistory(read: Read, main: () => Promise<string | null>) {
  const object = async (oid: string, type: GitObject["type"]) => {
    const found = await read(oid);
    if (!found || found.type !== type)
      throw new DriveError("missing", `A ${type} in this vault's history is unavailable`);
    return found.content;
  };
  const entries = async (tree: string) => {
    const content = await object(tree, "tree");
    try {
      return parseTree(content);
    } catch {
      throw new DriveError("integrity", "A stored Git tree is malformed");
    }
  };
  const blobAt = async (tree: string, path: string) => {
    let current = tree;
    const parts = path.split("/");
    for (const [index, name] of parts.entries()) {
      const entry = (await entries(current)).find((candidate) => candidate.name === name);
      if (!entry) return null;
      const directory = entry.kind === "directory";
      if (index === parts.length - 1) return directory ? null : entry.oid;
      if (!directory) return null;
      current = entry.oid;
    }
    return null;
  };
  const commit = async (oid: string) => parseCommit(await object(oid, "commit"));

  return {
    async history(input: { path?: string; at?: string; limit?: number } = {}) {
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new DriveError("invalid", "History limit must be between 1 and 100");
      const start = input.at ?? (await main());
      if (!start) return [];
      const { path } = input;
      // A commit is read, and its note looked up, once per walk: it is visited and also compared
      // against as its children's parent.
      const visits = new Map<
        string,
        Promise<{ commit: Awaited<ReturnType<typeof commit>>; blob: string | null }>
      >();
      const visit = (oid: string) => {
        let found = visits.get(oid);
        if (!found) {
          found = commit(oid).then(async (parsed) => ({
            commit: parsed,
            blob: path === undefined ? null : await blobAt(parsed.tree, path),
          }));
          visits.set(oid, found);
        }
        return found;
      };
      const versions: NoteVersion[] = [];
      const pending = [start],
        seen = new Set<string>([start]);
      for (
        let next = 0;
        next < pending.length && versions.length < limit && next < scanLimit;
        next++
      ) {
        const oid = pending[next]!;
        const { commit: current, blob } = await visit(oid);
        for (const parent of current.parents)
          if (!seen.has(parent)) {
            seen.add(parent);
            pending.push(parent);
          }
        if (path !== undefined) {
          const before = await Promise.all(
            current.parents.map(async (parent) => (await visit(parent)).blob),
          );
          const changed = current.parents.length
            ? before.every((other) => other !== blob)
            : blob !== null;
          if (!changed) continue;
        }
        versions.push({
          oid,
          parents: current.parents,
          message: current.message,
          time: isoTime(current.author.time),
        });
      }
      return versions;
    },
    head: main,
    /** The time of main's latest commit, or null for a vault with no commits yet. */
    async lastChange() {
      const head = await main();
      return head ? isoTime((await commit(head)).author.time) : null;
    },
  };
}
