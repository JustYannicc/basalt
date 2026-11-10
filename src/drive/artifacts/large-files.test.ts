// The stand-in for Artifacts is real `git http-backend`; see stores.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { backend, git } from "./test/backend.ts";
import { device } from "./test/vault.ts";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const partBytes = 1024 * 1024;
/** A deterministic, incompressible-looking ~15 MB file that differs per version. */
const pdf = (version: number) => {
  const bytes = new Uint8Array(15 * 1000 * 1000);
  let state = 0x9e3779b9 ^ version;
  for (let i = 0; i < bytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"), 0);
  return bytes;
};

test("a 15 MB PDF replaced twice restores version 1 byte for byte", async () => {
  const server = await backend();
  const vault = await device(server);
  try {
    type Vault = typeof vault;
    const upload = async (bytes: Uint8Array, operation: string) => {
      const oid = sha256(bytes);
      const started = await vault.attachments.begin({ operation, oid, bytes: bytes.length });
      for (let part = 0; part * partBytes < bytes.length; part++)
        await vault.attachments.put({
          upload: started.upload,
          part,
          content: bytes.subarray(part * partBytes, (part + 1) * partBytes),
        });
      let done = await vault.attachments.complete({ upload: started.upload });
      while (done.next !== null)
        done = await vault.attachments.complete({ upload: started.upload, cursor: done.next });
      return oid;
    };
    const readAll = async (reader: Vault, at: string) => {
      const hash = createHash("sha256");
      let offset: number | null = 0,
        total = 0;
      while (offset !== null) {
        const chunk = await reader.service.attachment({ path: "paper.pdf", at, offset });
        assert.ok(chunk);
        const bytes = Buffer.from(chunk.contentBase64, "base64");
        hash.update(bytes);
        total += bytes.length;
        offset = chunk.next;
      }
      return { sha256: hash.digest("hex"), bytes: total };
    };

    const versions = [pdf(1), pdf(2), pdf(3)];
    let base = vault.root;
    const commits: string[] = [];
    for (const [index, bytes] of versions.entries()) {
      const oid = await upload(bytes, `pdf-${index + 1}`);
      const saved = await vault.service.attach({
        base,
        path: "paper.pdf",
        operation: `attach-${index + 1}`,
        oid,
        bytes: bytes.length,
      });
      assert.equal(saved.state, "landed");
      commits.push(saved.oid);
      base = saved.oid;
    }
    // Every version is a small pointer in Git history; the bytes never entered the repository.
    for (const [index, commit] of commits.entries())
      assert.equal(
        git(server.bare, "show", `${commit}:paper.pdf`).toString(),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${sha256(versions[index]!)}\nsize ${versions[index]!.length}\n`,
      );
    const restored = await vault.service.restore({
      base,
      from: commits[0]!,
      path: "paper.pdf",
      operation: "restore-v1",
    });
    assert.equal(restored.state, "landed");
    assert.deepEqual(await readAll(vault, restored.oid), {
      sha256: sha256(versions[0]!),
      bytes: versions[0]!.length,
    });
    for (const [index, commit] of commits.entries())
      assert.equal((await readAll(vault, commit)).sha256, sha256(versions[index]!));
    const history = (await vault.drive.history({ limit: 10 })).map((entry) => entry.oid);
    for (const commit of [restored.oid, ...commits]) assert.ok(history.includes(commit));
    git(server.bare, "fsck", "--full", "--strict");
    assert.ok(
      Number(
        git(server.bare, "count-objects", "-v")
          .toString()
          .match(/size-pack: (\d+)/)?.[1] ?? 0,
      ) < 1024,
    );
  } finally {
    vault.close();
    await server.close();
  }
});
