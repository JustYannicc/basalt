import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { storageFixture } from "../../src/drive/fixture.ts";
import { openVault } from "../../src/drive/vault.ts";
import { encodeAttachmentPointer } from "../../src/drive/shared/bytes.ts";
import { createBinaryClient } from "./binary.ts";
import { createSync } from "./sync.ts";
import { decodeReceipt } from "./remote.ts";
import { conflictSides } from "./conflict-sides.ts";
import type { BinaryIo, BinaryState, RemoteBinary } from "./binary-types.ts";
import type { LocalVault, RemoteVault, SyncState } from "./types.ts";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function device(initial: Record<string, Uint8Array<ArrayBuffer>> = {}) {
  let revision = 0;
  const files = new Map(
      Object.entries(initial).map(([path, content]) => [
        path,
        { content, stamp: String(++revision) },
      ]),
    ),
    temps = new Map<string, Uint8Array<ArrayBuffer>>(),
    recovered = new Map<string, Uint8Array<ArrayBuffer>>();
  let binary: BinaryState | null = null,
    sync: SyncState | null = null;
  const pins: string[] = [];
  const snapshot = async (path: string) => {
    const value = files.get(path);
    return value ? { bytes: value.content.length, stamp: value.stamp } : null;
  };
  const io: BinaryIo = {
    snapshot,
    async read(path, expected, offset, length) {
      const file = files.get(path);
      if (!file || file.stamp !== expected.stamp) throw new Error("Local attachment changed");
      return file.content.slice(offset, offset + length);
    },
    async beginDownload(id) {
      if (!temps.has(id)) temps.set(id, new Uint8Array());
      return temps.get(id)!.length;
    },
    async readDownload(id, offset, length) {
      return temps.get(id)!.slice(offset, offset + length);
    },
    async appendDownload(id, offset, content) {
      const previous = temps.get(id)!;
      assert.equal(previous.length, offset);
      const next = new Uint8Array(offset + content.length);
      next.set(previous);
      next.set(content, offset);
      temps.set(id, next);
    },
    async publishDownload(input) {
      if (JSON.stringify(await snapshot(input.path)) !== JSON.stringify(input.expected))
        return false;
      files.set(input.path, { content: temps.get(input.id)!.slice(), stamp: String(++revision) });
      temps.delete(input.id);
      return true;
    },
    async removeDownload(id) {
      temps.delete(id);
    },
    async preserve(path, expected) {
      const file = files.get(path);
      if (!file || file.stamp !== expected.stamp) return false;
      recovered.set(path, file.content);
      files.delete(path);
      return true;
    },
    async evict(path, expected) {
      const file = files.get(path);
      if (!file || file.stamp !== expected.stamp) return false;
      files.delete(path);
      return true;
    },
    async noteLinks(path) {
      const file = files.get(path);
      return file
        ? [...new TextDecoder().decode(file.content).matchAll(/!\[\[([^\]]+)\]\]/gu)].map(
            (match) => match[1]!,
          )
        : [];
    },
  };
  const text: LocalVault = {
    files: async () =>
      [...files].map(([path, value]) => ({
        path,
        bytes: value.content.length,
        stamp: value.stamp,
      })),
    read: async (path) =>
      files.has(path) ? new TextDecoder().decode(files.get(path)!.content) : null,
    async replace(path, expected, content) {
      const actual = await this.read(path);
      if (actual !== expected) return false;
      if (content === null) files.delete(path);
      else
        files.set(path, { content: new TextEncoder().encode(content), stamp: String(++revision) });
      return true;
    },
  };
  return {
    io,
    text,
    files,
    temps,
    recovered,
    store: {
      load: async () => structuredClone(binary),
      save: async (value: BinaryState) => {
        binary = structuredClone(value);
      },
    },
    syncStore: {
      load: async () => structuredClone(sync),
      save: async (value: SyncState) => {
        sync = structuredClone(value);
      },
    },
    pins: {
      get: () => pins,
      set: async (values: readonly string[]) => {
        pins.splice(0, pins.length, ...values);
      },
    },
    put(path: string, content: Uint8Array<ArrayBuffer>) {
      files.set(path, { content, stamp: String(++revision) });
    },
  };
}
async function cloud() {
  const data = storageFixture(),
    account = storageFixture(),
    vault = await openVault({ ...data, accountStorage: account.storage, prefix: "client-bytes/" });
  let lose = false,
    parts = 0,
    maxPart = 0;
  const remote: RemoteVault & RemoteBinary = {
    ...vault.service,
    info: vault.service.info,
    beginAttachment: (value) => vault.attachments.begin(value),
    async uploadAttachmentPart(value) {
      parts++;
      const content = new Uint8Array(Buffer.from(value.contentBase64, "base64"));
      maxPart = Math.max(maxPart, content.length);
      const result = await vault.attachments.put({ ...value, content });
      if (lose) {
        lose = false;
        throw new Error("Reply lost");
      }
      return result;
    },
    completeAttachment: (value) => vault.attachments.complete(value),
    cancelAttachment: (value) => vault.attachments.cancel(value),
    download: (value) => vault.service.attachment(value),
    receipt: (operation) => vault.service.receipt({ operation }),
    apply: async (value) => decodeReceipt(await vault.service.apply(value)),
    resolve: async (value) => decodeReceipt(await vault.service.resolve(value)),
    async read(input) {
      const info = await vault.service.info(input);
      if (info?.attachment) {
        const content = new TextDecoder().decode(encodeAttachmentPointer(info.attachment)),
          offset = input.offset ?? 0,
          end = Math.min(content.length, offset + (input.maxBytes ?? 65536));
        return {
          blob: info.blob,
          bytes: content.length,
          content: content.slice(offset, end),
          next: end === content.length ? null : end,
        };
      }
      return vault.service.read(input);
    },
  };
  return {
    vault,
    remote,
    lose: () => {
      lose = true;
    },
    parts: () => parts,
    maxPart: () => maxPart,
    close: () => {
      data.close();
      account.close();
    },
  };
}

test("a large Mac attachment resumes after a lost part reply without resending accepted bytes", async () => {
  const c = await cloud(),
    data = Uint8Array.from(
      { length: 17 * 1024 * 1024 + 13 },
      (_, i) => (i * 19 + (i >>> 10)) & 255,
    ),
    mac = device({ "large.pdf": data });
  let seq = 0;
  const open = () =>
    createBinaryClient({
      text: mac.text,
      io: mac.io,
      remote: c.remote,
      store: mac.store,
      pins: mac.pins,
      mode: "full",
      id: () => String(++seq),
      changed: () => {},
    });
  try {
    c.lose();
    let binary = await open();
    let sync = await createSync({
      local: binary.local,
      remote: c.remote,
      store: mac.syncStore,
      id: () => String(++seq),
    });
    await assert.rejects(sync.run(), /Reply lost/);
    assert.equal(c.parts(), 1);
    binary.close();
    binary = await open();
    sync = await createSync({
      local: binary.local,
      remote: c.remote,
      store: mac.syncStore,
      id: () => String(++seq),
    });
    await sync.run();
    assert.equal(c.parts(), Math.ceil(data.length / 1048576));
    assert.equal(c.maxPart(), 1048576);
    assert.equal((await c.vault.status()).currentBytes, data.length);
    assert.equal(
      (await c.vault.service.info({ path: "large.pdf" }))?.attachment?.oid,
      digest(data),
    );
    assert.deepEqual(mac.files.get("large.pdf")?.content, data);
    assert.equal(sync.status().state, "idle");
  } finally {
    c.close();
  }
});

test("the phone fetches opened-note attachments and pinned folders while eviction never deletes cloud files", async () => {
  const c = await cloud(),
    encoder = new TextEncoder(),
    source = device({
      "open.md": encoder.encode("![[Pictures/photo.bin]]"),
      "Offline/note.md": encoder.encode("![[Audio/song.bin]]"),
      "Pictures/photo.bin": new Uint8Array(90000).fill(3),
      "Offline/doc.pdf": new Uint8Array(70000).fill(4),
      "Audio/song.bin": new Uint8Array(5000).fill(5),
    });
  let sequence = 0;
  const make = async (value: ReturnType<typeof device>, mode: "full" | "on-demand") => {
    const binary = await createBinaryClient({
        text: value.text,
        io: value.io,
        remote: c.remote,
        store: value.store,
        pins: value.pins,
        mode,
        id: () => String(++sequence),
        changed: () => {},
      }),
      sync = await createSync({
        local: binary.local,
        remote: c.remote,
        store: value.syncStore,
        id: () => String(++sequence),
      });
    return { binary, sync };
  };
  try {
    await (await make(source, "full")).sync.run();
    const size = (await c.vault.status()).currentBytes,
      phone = device(),
      p = await make(phone, "on-demand");
    await p.sync.run();
    assert.equal(phone.files.has("open.md"), true);
    assert.equal(phone.files.has("Pictures/photo.bin"), false);
    assert.equal(p.binary.summary().cloudOnly, 3);
    await p.binary.noteOpened("open.md", new AbortController().signal);
    assert.deepEqual(
      phone.files.get("Pictures/photo.bin")?.content,
      source.files.get("Pictures/photo.bin")?.content,
    );
    assert.equal(phone.files.has("Offline/doc.pdf"), false);
    await p.binary.setPinned("Offline", true);
    await p.binary.flush();
    assert.equal(phone.files.has("Offline/doc.pdf"), true);
    assert.equal(phone.files.has("Audio/song.bin"), true);
    await p.binary.setPinned("Offline", false);
    await p.binary.evict("Offline/doc.pdf");
    await p.binary.evict("Pictures/photo.bin");
    await p.sync.run();
    assert.equal(phone.files.has("Offline/doc.pdf"), false);
    assert.equal(phone.files.has("Pictures/photo.bin"), false);
    assert.equal((await c.vault.status()).currentBytes, size);
    assert.ok(await c.vault.service.info({ path: "Offline/doc.pdf" }));
    assert.ok(await c.vault.service.info({ path: "Pictures/photo.bin" }));
    const mirror = device(),
      m = await make(mirror, "full");
    await m.sync.run();
    await m.binary.flush();
    assert.deepEqual(
      mirror.files.get("Audio/song.bin")?.content,
      source.files.get("Audio/song.bin")?.content,
    );
    assert.equal(mirror.files.size, source.files.size);
  } finally {
    c.close();
  }
});

test("a local binary edit during a download keeps both versions and explicit resolution retains both Git parents", async () => {
  const c = await cloud(),
    original = new Uint8Array(250000).fill(1),
    agent = new Uint8Array(250000).fill(2),
    localEdit = new Uint8Array(32000).fill(3),
    mac = device({ "conflict.pdf": original });
  let sequence = 0;
  let sync: Awaited<ReturnType<typeof createSync>>;
  try {
    const binary = await createBinaryClient({
      text: mac.text,
      io: mac.io,
      remote: c.remote,
      store: mac.store,
      pins: mac.pins,
      mode: "full",
      id: () => String(++sequence),
      changed: () => {},
      resolve: (ref, edits) => sync.resolve(ref, edits),
    });
    sync = await createSync({
      local: binary.local,
      remote: c.remote,
      store: mac.syncStore,
      id: () => String(++sequence),
    });
    await sync.run();
    const before = (await c.vault.service.list()).at,
      oid = digest(agent),
      upload = await c.vault.attachments.begin({
        operation: "agent-upload",
        oid,
        bytes: agent.length,
      });
    await c.vault.attachments.put({ upload: upload.upload, part: 0, content: agent });
    await c.vault.attachments.complete({ upload: upload.upload });
    await c.vault.service.attach({
      base: before,
      path: "conflict.pdf",
      operation: "agent-edit",
      oid,
      bytes: agent.length,
    });
    const append = mac.io.appendDownload;
    let raced = false;
    mac.io.appendDownload = async (...args) => {
      await append(...args);
      if (!raced) {
        raced = true;
        mac.put("conflict.pdf", localEdit);
      }
    };
    await sync.run();
    assert.equal(sync.status().state, "conflict");
    assert.deepEqual(mac.files.get("conflict.pdf")?.content, localEdit);
    const conflict = sync.conflicts()[0]!;
    const sides = conflictSides(conflict.conflicts[0]!);
    assert.equal(
      (await binary.describeVersion("conflict.pdf", sides.deviceAt))?.bytes,
      localEdit.length,
    );
    assert.equal(
      (await binary.describeVersion("conflict.pdf", sides.cloudAt))?.bytes,
      agent.length,
    );
    assert.equal((await c.vault.service.info({ path: "conflict.pdf" }))?.attachment?.oid, oid);
    assert.equal(
      (await c.vault.service.attachment({ path: "conflict.pdf", at: conflict.oid }))?.contentBase64,
      Buffer.from(localEdit).toString("base64"),
    );
    assert.equal(
      (await binary.describeVersion("conflict.pdf", conflict.main))?.bytes,
      agent.length,
    );
    await binary.resolveMixed(conflict.ref, [
      { path: "conflict.pdf", kind: "version", at: sides.cloudAt },
    ]);
    assert.equal(sync.status().state, "idle");
    assert.deepEqual(mac.files.get("conflict.pdf")?.content, agent);
    assert.equal((await c.vault.service.history())[0]?.parents.length, 2);
  } finally {
    c.close();
  }
});

test("an interrupted phone download resumes from its existing temporary bytes and verifies the complete file", async () => {
  const c = await cloud(),
    content = new Uint8Array(220000).fill(9),
    source = device({ "resume.pdf": content }),
    phone = device();
  let sequence = 0;
  const open = (value: ReturnType<typeof device>, mode: "full" | "on-demand") =>
    createBinaryClient({
      text: value.text,
      io: value.io,
      remote: c.remote,
      store: value.store,
      pins: value.pins,
      mode,
      id: () => String(++sequence),
      changed: () => {},
    });
  try {
    const mac = await open(source, "full");
    await (
      await createSync({
        local: mac.local,
        remote: c.remote,
        store: source.syncStore,
        id: () => String(++sequence),
      })
    ).run();
    let binary = await open(phone, "on-demand");
    await (
      await createSync({
        local: binary.local,
        remote: c.remote,
        store: phone.syncStore,
        id: () => String(++sequence),
      })
    ).run();
    const offsets: number[] = [],
      download = c.remote.download;
    c.remote.download = async (input) => {
      offsets.push(input.offset);
      return download(input);
    };
    const append = phone.io.appendDownload;
    let lose = true;
    phone.io.appendDownload = async (...args) => {
      await append(...args);
      if (lose) {
        lose = false;
        throw new Error("Append reply lost");
      }
    };
    await assert.rejects(
      binary.download("resume.pdf", new AbortController().signal),
      /Append reply lost/,
    );
    assert.deepEqual(offsets, [0]);
    assert.equal(phone.files.has("resume.pdf"), false);
    binary.close();
    binary = await open(phone, "on-demand");
    await binary.download("resume.pdf", new AbortController().signal);
    assert.deepEqual(offsets, [0, 65536, 131072, 196608]);
    assert.deepEqual(phone.files.get("resume.pdf")?.content, content);
    assert.equal(phone.temps.size, 0);
  } finally {
    c.close();
  }
});

test("a large Markdown note stays text in cloud reads/search and is present offline on a phone", async () => {
  const c = await cloud();
  const content = new TextEncoder().encode(
    "a".repeat(8 * 1048576 + 65530) + "\n跨頁 needle beyond eight megabytes\n",
  );
  const source = device({ "large.md": content }),
    phone = device();
  let sequence = 0;
  const open = (value: ReturnType<typeof device>, mode: "full" | "on-demand") =>
    createBinaryClient({
      text: value.text,
      io: value.io,
      remote: c.remote,
      store: value.store,
      pins: value.pins,
      mode,
      id: () => String(++sequence),
      changed: () => {},
    });
  try {
    const mac = await open(source, "full");
    await (
      await createSync({
        local: mac.local,
        remote: c.remote,
        store: source.syncStore,
        id: () => String(++sequence),
      })
    ).run();
    const last = await c.vault.service.read({
      path: "large.md",
      offset: content.length - new TextEncoder().encode("needle beyond eight megabytes\n").length,
      maxBytes: 35,
    });
    assert.ok(last);
    assert.ok(last.content.includes("needle"));
    assert.equal(last.next, null);
    assert.equal(
      (await mac.describeVersion("large.md", (await c.vault.service.list()).at))?.external,
      true,
    );
    let cursor: import("../../src/drive/search.ts").SearchCursor | undefined,
      found = false,
      pages = 0;
    do {
      const page = await c.vault.service.search({ query: "needle", ...(cursor ? { cursor } : {}) });
      pages++;
      found ||= page.matches.some((match) => match.path === "large.md" && match.line === 2);
      cursor = page.cursor ?? undefined;
    } while (cursor);
    assert.ok(found);
    assert.ok(pages > 1);
    const mobile = await open(phone, "on-demand");
    await (
      await createSync({
        local: mobile.local,
        remote: c.remote,
        store: phone.syncStore,
        id: () => String(++sequence),
      })
    ).run();
    assert.deepEqual(phone.files.get("large.md")?.content, content);
    await assert.rejects(mobile.evict("large.md"), /kept offline/);
  } finally {
    c.close();
  }
});
