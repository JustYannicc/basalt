import type { Bytes } from "../types.js";

class FsError extends Error {
  constructor(
    public readonly code: string,
    path: string,
  ) {
    super(`${code}: ${path}`);
  }
}

interface Entry {
  data: Bytes | null;
  dirty: boolean;
}
const normalize = (path: string) => {
  const result: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") result.pop();
    else if (part && part !== ".") result.push(part);
  }
  return `/${result.join("/")}`;
};
const parent = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

// One disposable Git operation owns this filesystem. Only immutable objects are loaded lazily.
export function createFilesystem(load: (oid: string) => Promise<Bytes | null>, maxBytes: number) {
  const entries = new Map<string, Entry>([["/", { data: null, dirty: false }]]);
  let held = 0;
  const save = (path: string, data: Bytes, dirty: boolean) => {
    const next = held - (entries.get(path)?.data?.length ?? 0) + data.length;
    if (next > maxBytes) throw new FsError("ENOSPC", "Git operation memory budget");
    held = next;
    entries.set(path, { data: data.slice(), dirty });
  };
  const lookup = async (path: string) => {
    const existing = entries.get(path);
    if (existing) return existing;
    const match = /^\/repo\/\.git\/objects\/([a-f0-9]{2})\/([a-f0-9]{38})$/.exec(path);
    if (match) {
      const data = await load(match[1]! + match[2]!);
      if (data) {
        save(path, data, false);
        return entries.get(path)!;
      }
    }
    throw new FsError("ENOENT", path);
  };
  const mkdir = async (input: string) => {
    const path = normalize(input);
    if (path === "/") return;
    await mkdir(parent(path));
    const old = entries.get(path);
    if (old?.data) throw new FsError("ENOTDIR", path);
    entries.set(path, { data: null, dirty: false });
  };
  const stat = async (input: string) => {
    const entry = await lookup(normalize(input));
    return {
      size: entry.data?.length ?? 0,
      mode: entry.data ? 0o100644 : 0o040000,
      mtimeMs: 0,
      ctimeMs: 0,
      isFile: () => entry.data !== null,
      isDirectory: () => entry.data === null,
      isSymbolicLink: () => false,
    };
  };
  const promises = {
    async readFile(input: string, options?: string | { encoding?: string }) {
      const entry = await lookup(normalize(input));
      if (!entry.data) throw new FsError("EISDIR", input);
      const encoding = typeof options === "string" ? options : options?.encoding;
      return encoding ? new TextDecoder().decode(entry.data) : entry.data.slice();
    },
    async writeFile(input: string, data: string | Uint8Array) {
      const path = normalize(input);
      await mkdir(parent(path));
      save(
        path,
        typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
        true,
      );
    },
    async unlink(input: string) {
      const path = normalize(input),
        entry = await lookup(path);
      if (!entry.data) throw new FsError("EISDIR", path);
      held -= entry.data.length;
      entries.delete(path);
    },
    async readdir(input: string) {
      const path = normalize(input);
      await lookup(path);
      return [...entries.keys()]
        .filter((key) => key !== path && parent(key) === path)
        .map((key) => key.slice(key.lastIndexOf("/") + 1));
    },
    mkdir,
    async rmdir(input: string) {
      const path = normalize(input);
      if ((await promises.readdir(path)).length) throw new FsError("ENOTEMPTY", path);
      entries.delete(path);
    },
    stat,
    lstat: stat,
    async readlink(input: string): Promise<string> {
      throw new FsError("EINVAL", input);
    },
    async symlink(_target: string, input: string): Promise<void> {
      throw new FsError("ENOTSUP", input);
    },
    async chmod(_input: string, _mode: number) {},
    async rename(from: string, to: string) {
      const entry = await lookup(normalize(from));
      if (!entry.data) throw new FsError("ENOTSUP", from);
      await promises.writeFile(to, entry.data);
      await promises.unlink(from);
    },
  };
  return {
    promises,
    dirtyObjects: () =>
      [...entries].flatMap(([path, entry]) => {
        const match = /^\/repo\/\.git\/objects\/([a-f0-9]{2})\/([a-f0-9]{38})$/.exec(path);
        return match && entry.dirty && entry.data
          ? [{ oid: match[1]! + match[2]!, data: entry.data }]
          : [];
      }),
  };
}
