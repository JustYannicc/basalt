import { DriveError, filePath, oid } from "./errors.js";
import { objectId, parseCommit, parseTree, type TreeEntry } from "./git/objects.js";
import type { ObjectStore } from "./types.js";
export interface ChangeCursor {
  from: string | null;
  to: string;
  frames: readonly { name: string; after: string }[];
}
export interface ChangeInput {
  from: string | null;
  to: string;
  cursor?: ChangeCursor;
  limit?: number;
  maxEntries?: number;
}
export interface Change {
  path: string;
  before: string | null;
  after: string | null;
}
export function createChangeReader(objects: ObjectStore) {
  return async (input: ChangeInput) => {
    const from = input.from === null ? null : oid(input.from),
      to = oid(input.to),
      limit = input.limit ?? 50,
      maxEntries = input.maxEntries ?? 10000;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 10000
    )
      throw new DriveError("invalid", "Change page exceeds its work or result bound");
    const cursor = input.cursor;
    if (
      cursor &&
      (cursor.from !== from ||
        cursor.to !== to ||
        cursor.frames.length > 33 ||
        JSON.stringify(cursor).length > 65536)
    )
      throw new DriveError(
        "invalid",
        "Change cursor belongs to different revisions or exceeds its bound",
      );
    const frames = cursor
      ? cursor.frames.map((frame) => ({ ...frame }))
      : [{ name: "", after: "" }];
    for (const [index, frame] of frames.entries()) {
      if (
        (index === 0 && frame.name !== "") ||
        (index > 0 &&
          (filePath(frame.name).length !== 1 || frames[index - 1]!.after !== frame.name)) ||
        (frame.after && filePath(frame.after).length !== 1)
      )
        throw new DriveError("invalid", "Invalid change cursor name");
    }
    if (frames.length > 1)
      filePath(
        frames
          .slice(1)
          .map((frame) => frame.name)
          .join("/"),
      );
    const load = async (id: string, type: "commit" | "tree") => {
      const object = await objects.get(id);
      if (
        !object ||
        object.type !== type ||
        object.content.length > 8 * 1024 * 1024 ||
        (await objectId(type, object.content)) !== id
      )
        throw new DriveError(
          "integrity",
          "Change tree references missing or corrupt canonical objects",
        );
      return object.content;
    };
    const leftRoot = from === null ? null : parseCommit(await load(from, "commit")).tree,
      rightRoot = parseCommit(await load(to, "commit")).tree;
    const cache = new Map<string, readonly TreeEntry[]>();
    let cacheBytes = 0;
    const directory = async (id: string | null) => {
      if (id === null) return [];
      const known = cache.get(id);
      if (known) return known;
      const bytes = await load(id, "tree"),
        entries = parseTree(bytes);
      if (entries.length > 100000)
        throw new DriveError("capacity", "Change tree has too many entries");
      for (const entry of entries)
        if (
          filePath(entry.name).length !== 1 ||
          (entry.kind !== "file" && entry.kind !== "directory")
        )
          throw new DriveError("invalid", "Change tree has an unsupported entry");
      if (cacheBytes + bytes.length > 16 * 1024 * 1024) {
        cache.clear();
        cacheBytes = 0;
      }
      cache.set(id, entries);
      cacheBytes += bytes.length;
      return entries;
    };
    const treeAt = async (root: string | null, path: string) => {
      let current = root;
      for (const name of path.split("/").filter(Boolean)) {
        const entry = (await directory(current)).find((entry) => entry.name === name);
        current = entry?.kind === "directory" ? entry.oid : null;
      }
      return current;
    };
    const entries: Change[] = [];
    let scanned = 0,
      outputBytes = 0;
    while (frames.length && entries.length < limit && scanned < maxEntries) {
      const frame = frames.at(-1)!,
        directoryPath = frames
          .slice(1)
          .map((frame) => frame.name)
          .join("/"),
        left = await treeAt(leftRoot, directoryPath),
        right = await treeAt(rightRoot, directoryPath);
      if (left === right) {
        frames.pop();
        continue;
      }
      const before = new Map((await directory(left)).map((entry) => [entry.name, entry])),
        after = new Map((await directory(right)).map((entry) => [entry.name, entry]));
      const names = [...new Set([...before.keys(), ...after.keys()])]
        .filter((name) => name > frame.after)
        .sort();
      let paused = false;
      for (const name of names) {
        if (entries.length >= limit || scanned >= maxEntries) {
          paused = true;
          break;
        }
        const a = before.get(name),
          b = after.get(name),
          path = directoryPath ? `${directoryPath}/${name}` : name;
        filePath(path);
        const change = {
          path,
          before: a?.kind === "file" ? a.oid : null,
          after: b?.kind === "file" ? b.oid : null,
        };
        const different = change.before !== change.after,
          size = different ? new TextEncoder().encode(JSON.stringify(change)).length : 0;
        if (different && outputBytes + size > 64000) {
          paused = true;
          break;
        }
        frame.after = name;
        scanned++;
        if (different) {
          entries.push(change);
          outputBytes += size;
        }
        if ((a?.kind === "directory" || b?.kind === "directory") && a?.oid !== b?.oid) {
          if (frames.length >= 33)
            throw new DriveError("capacity", "Change tree exceeds the directory depth bound");
          frames.push({ name, after: "" });
          paused = true;
          break;
        }
      }
      if (!paused) frames.pop();
    }
    return { from, to, entries, scanned, next: frames.length ? { from, to, frames } : null };
  };
}
