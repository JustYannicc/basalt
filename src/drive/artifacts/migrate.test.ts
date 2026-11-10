// The stand-in for Artifacts is real `git http-backend`; see stores.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { storageFixture } from "../fixture.ts";
import { openVault } from "../vault.ts";
import { openCloudflareStorage } from "../shared/index.ts";
import { migrateVault, copyAttachments } from "./migrate.ts";
import { backend, git } from "./test/backend.ts";
import { device, remoteMain, repository } from "./test/vault.ts";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** An R2-pack vault with linear history, a merge, an attachment and one kept conflict. */
async function packVault() {
  const data = storageFixture(),
    account = storageFixture();
  const input = { ...data, accountStorage: account.storage, prefix: "legacy/" };
  const vault = await openVault(input);
  const v1 = await vault.service.apply({
    base: vault.root,
    operation: "v1",
    edits: [{ path: "note.md", content: "one" }],
  });
  const v2 = await vault.service.apply({
    base: v1.oid,
    operation: "v2",
    edits: [{ path: "note.md", content: "two" }],
  });
  // A stale base merges: the second edit lands as a two-parent commit.
  const merged = await vault.service.apply({
    base: v1.oid,
    operation: "other-device",
    edits: [{ path: "other.md", content: "parallel" }],
  });
  const bytes = Uint8Array.from({ length: 3000 }, (_, i) => i % 251);
  const upload = await vault.attachments.begin({
    operation: "pdf",
    oid: sha256(bytes),
    bytes: bytes.length,
  });
  await vault.attachments.put({ upload: upload.upload, part: 0, content: bytes });
  await vault.attachments.complete({ upload: upload.upload });
  const attached = await vault.service.attach({
    base: merged.oid,
    path: "paper.pdf",
    operation: "attach",
    oid: sha256(bytes),
    bytes: bytes.length,
  });
  const conflict = await vault.service.apply({
    base: v1.oid,
    operation: "conflicting",
    edits: [{ path: "note.md", content: "conflicting edit" }],
  });
  assert.equal(conflict.state, "conflict");
  const refs = Object.fromEntries(
    [...data.storage.sql.exec("SELECT name, oid FROM drive_refs")].map((row) => [
      String(row.name),
      String(row.oid),
    ]),
  );
  const stores = await openCloudflareStorage({
    bucket: data.bucket,
    storage: data.storage,
    prefix: "legacy/",
  });
  return {
    objects: stores.objects,
    refs,
    data,
    commits: {
      v1: v1.oid,
      v2: v2.oid,
      merged: merged.oid,
      attached: attached.oid,
      conflict: conflict.oid,
    },
    bytes,
    close() {
      data.close();
      account.close();
    },
  };
}

test("an R2-pack vault migrates with identical commit ids, a clean fsck and its kept conflict", async () => {
  const server = await backend();
  const source = await packVault();
  try {
    // Tiny limits force many pushes, the way a vault over 64 MiB would split.
    const result = await migrateVault({
      objects: source.objects,
      refs: source.refs,
      repository: repository(server),
      limits: { objects: 4 },
    });
    assert.ok(result.pushes > 2, `pushes: ${result.pushes}`);
    assert.equal(remoteMain(server), source.refs["refs/heads/main"]);
    git(server.bare, "fsck", "--full", "--strict");
    const remoteCommits = new Set(
      git(server.bare, "rev-list", "--all").toString().trim().split("\n"),
    );
    for (const oid of Object.values(source.commits).filter(
      (oid) => oid !== source.commits.conflict,
    ))
      assert.ok(remoteCommits.has(oid), `commit ${oid} kept its id`);
    const kept = git(
      server.bare,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads/conflicts",
    )
      .toString()
      .trim();
    assert.match(kept, new RegExp(`^refs/heads/conflicts/\\S+ ${source.commits.conflict}$`));
    assert.equal(git(server.bare, "show", `${source.commits.v1}:note.md`).toString(), "one");
    // The tree holds the standard LFS pointer; the bytes copy key for key with the same id.
    assert.match(
      git(server.bare, "show", "main:paper.pdf").toString(),
      /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize 3000\n$/,
    );

    // Running it again changes nothing: main is already at the source head.
    const again = await migrateVault({
      objects: source.objects,
      refs: source.refs,
      repository: repository(server),
    });
    assert.equal(again.pushes, 0);
    assert.equal(remoteMain(server), source.refs["refs/heads/main"]);

    // An Artifacts-mode vault on the migrated repository reads every version, bytes included.
    const reader = await device(server);
    try {
      const copied = await copyAttachments({
        from: source.data.bucket,
        to: reader.bucket,
        fromPrefix: "legacy/",
        toPrefix: "vault/",
      });
      assert.ok(copied.copied > 0);
      assert.equal(
        (await reader.service.read({ path: "note.md", at: source.commits.v1 }))?.content,
        "one",
      );
      const pdf = await reader.service.attachment({ path: "paper.pdf" });
      assert.equal(pdf?.contentBase64, Buffer.from(source.bytes).toString("base64"));
    } finally {
      reader.close();
    }
  } finally {
    source.close();
    await server.close();
  }
});
