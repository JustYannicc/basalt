import type { DataFiles } from "./binary-file-types.ts";
const size = 1048576;
export function downloadFiles(adapter: DataFiles, root: string) {
  const directory = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new Error("Invalid temporary download identity");
    return root + "/" + id;
  };
  const part = (id: string, index: number) =>
    directory(id) + `/part-${String(index).padStart(5, "0")}.bin`;
  const mkdir = async (path: string) => {
    let current = "";
    for (const name of path.split("/")) {
      current = current ? current + "/" + name : name;
      if (!(await adapter.exists(current))) {
        try {
          await adapter.mkdir(current);
        } catch (failure) {
          if (!(await adapter.exists(current))) throw failure;
        }
      }
    }
  };
  const list = async (id: string) => {
    const folder = directory(id);
    if (!(await adapter.exists(folder))) return [];
    return (await adapter.list(folder)).files
      .filter((path) => /^part-[0-9]{5}\.bin$/u.test(path.slice(folder.length + 1)))
      .sort();
  };
  return {
    path: directory,
    async begin(id: string) {
      await mkdir(directory(id));
      const files = await list(id);
      let total = 0;
      for (const [index, path] of files.entries()) {
        if (path !== part(id, index)) throw new Error("Saved download has a gap");
        const stat = await adapter.stat(path);
        if (
          !stat ||
          stat.type !== "file" ||
          stat.size > size ||
          (index < files.length - 1 && stat.size !== size)
        )
          throw new Error("Saved download part has an invalid size");
        total += stat.size;
      }
      return total;
    },
    async read(id: string, offset: number, length: number) {
      const result = new Uint8Array(length);
      let copied = 0;
      while (copied < length) {
        const at = offset + copied,
          index = Math.floor(at / size),
          within = at % size,
          bytes = new Uint8Array(await adapter.readBinary(part(id, index))),
          count = Math.min(length - copied, bytes.length - within);
        if (count < 1 || bytes.length > size) throw new Error("Saved download range is missing");
        result.set(bytes.subarray(within, within + count), copied);
        copied += count;
      }
      return result;
    },
    async append(id: string, offset: number, bytes: Uint8Array<ArrayBuffer>) {
      const index = Math.floor(offset / size),
        within = offset % size,
        key = part(id, index);
      if (bytes.length > size || within + bytes.length > size)
        throw new Error("Download append crossed its part bound");
      const stat = await adapter.stat(key);
      if ((stat?.size ?? 0) !== within) throw new Error("Download append has a stale offset");
      if (!stat) await adapter.writeBinary(key, new ArrayBuffer(0));
      await adapter.appendBinary(key, bytes.slice().buffer);
    },
    async journal(id: string) {
      const key = directory(id) + "/publish.json";
      return (await adapter.exists(key)) ? JSON.parse(await adapter.read(key)) : null;
    },
    async writeJournal(id: string, value: unknown) {
      await mkdir(directory(id));
      await adapter.write(directory(id) + "/publish.json", JSON.stringify(value));
    },
    async remove(id: string) {
      for (const path of await list(id)) await adapter.remove(path);
      const key = directory(id) + "/publish.json";
      if (await adapter.exists(key)) await adapter.remove(key);
      if (
        (await adapter.exists(directory(id))) &&
        !(await adapter.list(directory(id))).files.length &&
        !(await adapter.list(directory(id))).folders.length
      )
        await adapter.rmdir(directory(id), false);
    },
  };
}
