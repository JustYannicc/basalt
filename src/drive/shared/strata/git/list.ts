import git from "isomorphic-git";
import { DriveError } from "../errors.js";
import type { ListEntry } from "../types.js";

type Context = Pick<Parameters<typeof git.readTree>[0], "fs" | "dir">;

export async function readDirectory(
  context: Context,
  commit: string,
  path: string,
  after: string,
  limit: number,
) {
  let tree;
  try {
    tree = (await git.readTree({ ...context, oid: commit, ...(path ? { filepath: path } : {}) }))
      .tree;
  } catch (error) {
    if (error instanceof git.Errors.NotFoundError)
      return { exists: false, entries: [], more: false };
    if (error instanceof git.Errors.ObjectTypeError)
      throw new DriveError("invalid", "Listing requires a directory path");
    throw error;
  }
  const selected = tree
    .filter((entry) => entry.path > after)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const entries: ListEntry[] = selected.slice(0, limit).map((entry) => {
    if (entry.type !== "tree" && entry.type !== "blob")
      throw new DriveError("invalid", "Directory contains an unsupported Git entry");
    return {
      name: entry.path,
      path: path ? `${path}/${entry.path}` : entry.path,
      kind: entry.type === "tree" ? "directory" : "file",
      oid: entry.oid,
    };
  });
  return { exists: true, entries, more: selected.length > limit };
}
