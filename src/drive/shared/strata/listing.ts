import { DriveError, filePath, oid } from "./errors.js";
import type { createEngine } from "./git/engine.js";
import type { Drive } from "./types.js";

type Engine = Awaited<ReturnType<typeof createEngine>>;

export function createListing(
  open: () => Promise<Engine>,
  main: () => Promise<string>,
): Drive["list"] {
  return async (input = {}) => {
    input = { ...input, ...(input.cursor ? { cursor: { ...input.cursor } } : {}) };
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw new DriveError("invalid", "Listing limit must be between 1 and 500");
    const cursor = input.cursor;
    if (cursor) {
      oid(cursor.at);
      if (!cursor.after || cursor.after.includes("/") || filePath(cursor.after).length !== 1)
        throw new DriveError("invalid", "Invalid listing cursor");
      if (
        (input.at !== undefined && input.at !== cursor.at) ||
        (input.path !== undefined && input.path !== cursor.path)
      )
        throw new DriveError("invalid", "Listing cursor belongs to another commit or directory");
    }
    const path = input.path ?? cursor?.path ?? "";
    if (path) filePath(path);
    const at = oid(input.at ?? cursor?.at ?? (await main()));
    const git = await open();
    await git.readCommit(at);
    const page = await git.list(at, path, cursor?.after ?? "", limit);
    return {
      at,
      path,
      exists: page.exists,
      entries: page.entries,
      next: page.more ? { at, path, after: page.entries.at(-1)!.name } : null,
    };
  };
}
