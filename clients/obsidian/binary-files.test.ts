import { test } from "node:test";
import assert from "node:assert/strict";
import { createBinaryIo } from "./binary-files.ts";
import { createLocalVault } from "./local-vault.ts";
import type { DataFiles } from "./binary-file-types.ts";
function fixture() {
  let clock = 0,
    lose = false;
  const files = new Map<string, { data: Uint8Array<ArrayBuffer>; mtime: number }>(),
    folders = new Set<string>(),
    owned = new Set<string>(),
    recovered = new Set<string>();
  let maxRead = 0;
  const stat = async (path: string) =>
    files.has(path)
      ? { type: "file" as const, size: files.get(path)!.data.length, mtime: files.get(path)!.mtime }
      : folders.has(path)
        ? { type: "folder" as const, size: 0, mtime: 0 }
        : null;
  const adapter: DataFiles = {
    stat,
    exists: async (path) => files.has(path) || folders.has(path),
    mkdir: async (path) => {
      folders.add(path);
    },
    list: async (path) => ({
      files: [...files.keys()].filter(
        (key) => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/"),
      ),
      folders: [...folders].filter(
        (key) => key.startsWith(path + "/") && !key.slice(path.length + 1).includes("/"),
      ),
    }),
    read: async (path) => new TextDecoder().decode(files.get(path)!.data),
    write: async (path, data) => {
      files.set(path, { data: new TextEncoder().encode(data), mtime: ++clock });
    },
    readBinary: async (path) => {
      const file = files.get(path)!;
      maxRead = Math.max(maxRead, file.data.length);
      return file.data.slice().buffer;
    },
    writeBinary: async (path, data) => {
      files.set(path, { data: new Uint8Array(data).slice(), mtime: ++clock });
    },
    appendBinary: async (path, data) => {
      const old = files.get(path)?.data ?? new Uint8Array(),
        next = new Uint8Array(old.length + data.byteLength);
      next.set(old);
      next.set(new Uint8Array(data), old.length);
      files.set(path, { data: next, mtime: ++clock });
    },
    remove: async (path) => {
      files.delete(path);
    },
    rmdir: async (path) => {
      folders.delete(path);
    },
    getResourcePath: (path) => "https://fixture.invalid/" + path,
  };
  const file = (path: string) =>
    files.has(path)
      ? { path, stat: { size: files.get(path)!.data.length, mtime: files.get(path)!.mtime } }
      : null;
  const vault = {
    getFiles: () =>
      [...files.keys()].filter((path) => !path.startsWith(".")).map((path) => file(path)!),
    getFileByPath: file,
    getAbstractFileByPath: (path: string) => file(path) ?? (folders.has(path) ? { path } : null),
    read: async (value: { path: string }) => adapter.read(value.path),
    process: async (value: { path: string }, fn: (content: string) => string) => {
      const result = fn(await adapter.read(value.path));
      await adapter.write(value.path, result);
      return result;
    },
    create: async (path: string, value: string) => {
      if (files.has(path)) throw new Error("File exists");
      await adapter.write(path, value);
      return file(path)!;
    },
    createFolder: adapter.mkdir,
    createBinary: async (path: string, data: ArrayBuffer) => {
      if (files.has(path)) throw new Error("File exists");
      await adapter.writeBinary(path, data);
      return file(path)!;
    },
    appendBinary: async (value: { path: string }, data: ArrayBuffer) =>
      adapter.appendBinary(value.path, data),
    rename: async (value: { path: string }, path: string) => {
      if (files.has(path)) throw new Error("File exists");
      const current = files.get(value.path);
      if (!current) throw new Error("File missing");
      files.set(path, current);
      files.delete(value.path);
      value.path = path;
      if (lose) {
        lose = false;
        throw new Error("Rename reply lost");
      }
    },
    delete: async (value: { path: string }) => {
      files.delete(value.path);
    },
  };
  const ownership = {
      get: () => [...owned],
      add: async (path: string) => {
        owned.add(path);
      },
      remove: async (path: string) => {
        owned.delete(path);
      },
    },
    local = createLocalVault(vault, {
      recoveries: {
        get: () => [...recovered],
        add: async (path) => {
          recovered.add(path);
        },
      },
      transfers: ownership.get,
    });
  const io = createBinaryIo({
    adapter,
    vault,
    local,
    privateRoot: ".obsidian/plugins/signalbox-sync/cache/app",
    transferRoot: "Signalbox transfers/device/app",
    ownership,
    id: () => String(++clock),
  });
  return {
    io,
    files,
    local,
    owned,
    recovered,
    maxRead: () => maxRead,
    lose: () => {
      lose = true;
    },
  };
}
test("public file APIs assemble bounded parts, recover a lost rename and keep ordinary cloud recovery-folder files", async () => {
  const f = fixture(),
    data = new Uint8Array(2 * 1048576 + 19).fill(7);
  await f.io.beginDownload("test");
  for (let offset = 0; offset < data.length; offset += 65536)
    await f.io.appendDownload("test", offset, data.slice(offset, offset + 65536));
  assert.equal(await f.io.beginDownload("test"), data.length);
  assert.deepEqual(
    await f.io.readDownload("test", 1048576 - 5, 13),
    data.slice(1048576 - 5, 1048576 + 8),
  );
  f.files.set("target.pdf", { data: new Uint8Array([1, 2, 3]), mtime: 1 });
  const expected = await f.io.snapshot("target.pdf");
  f.lose();
  await assert.rejects(
    f.io.publishDownload({ id: "test", path: "target.pdf", expected }),
    /Rename reply lost/,
  );
  assert.equal(f.files.has("target.pdf"), false);
  assert.ok(await f.io.pendingSnapshot("target.pdf", "test"));
  assert.equal(
    await f.io.publishDownload({ id: "test", path: "target.pdf", expected: null }),
    true,
  );
  assert.deepEqual(f.files.get("target.pdf")?.data, data);
  assert.ok(f.maxRead() <= 1048576);
  assert.equal(
    await f.local.replace("Signalbox recovered/from-agent.md", null, "agent file"),
    true,
  );
  assert.equal(await f.local.read("Signalbox recovered/from-agent.md"), "agent file");
  assert.equal(
    (await f.local.files()).some((file) => file.path.includes("Signalbox transfers")),
    false,
  );
  assert.equal(f.local.recovered().length, 1);
});
