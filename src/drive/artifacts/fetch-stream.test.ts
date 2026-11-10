import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { storageFixture } from "../fixture.ts";
import { createDrive } from "../shared/index.ts";
import { objectId } from "../shared/.generated/strata/git/objects.js";
import { writtenObject } from "../shared/.generated/strata/git/write.js";
import { createArtifactsStores } from "./stores.ts";
import { createObjectCache } from "./object-cache.ts";
import { createGitRemote, ProtocolError, maximumReplyBytes } from "./transport.ts";
import { fetchStream } from "./fetch-stream.ts";
import { backend, git, pkt, responsePack, token } from "./test/backend.ts";
import { repository } from "./test/vault.ts";
import { deltaKinds, largeHistory, sampleBytes } from "./test/large-history.ts";

const main = "refs/heads/main";
const author = {
  name: "Fixture",
  email: "fixture@example.invalid",
  timestamp: 1800000000,
  timezoneOffset: 0,
};
const sha1 = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest();
const rawResponse = (pack: Uint8Array) => new Response(Buffer.concat([pkt("NAK\n"), pack]));
const bandedReply = (pack: Uint8Array) =>
  Buffer.concat([
    pkt("NAK\n"),
    ...Array.from({ length: Math.ceil(pack.length / 60000) }, (_, i) =>
      pkt(Buffer.concat([Buffer.from([1]), pack.subarray(i * 60000, (i + 1) * 60000)])),
    ),
    Buffer.from("0000"),
  ]);

// The metric counts parser-owned allocations and inflation/delta work, not process RSS or the
// HTTP fixture's server-side copy. A slow sink also proves reading follows persistence.
test(
  "a cold vault streams a >32 MiB delta history, then reads sampled versions byte-identically",
  { timeout: 60000 },
  async (t) => {
    const server = await backend();
    t.after(() => server.close());
    const history = largeHistory(server.root, server.bare),
      data = storageFixture();
    t.after(() => data.close());
    assert.ok(history.packBytes > 45 * 1024 * 1024);
    let peak = 0,
      writes = 0,
      received = 0,
      earlyWrite = false;
    const remote = createGitRemote({
      url: server.url,
      auth: async () => token,
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        if (init?.method !== "POST") return response;
        return new Response(
          response.body!.pipeThrough(
            new TransformStream({
              transform(chunk: Uint8Array, controller) {
                received += chunk.length;
                controller.enqueue(chunk);
              },
            }),
          ),
          { headers: response.headers },
        );
      },
    });
    const repo = repository(server),
      stores = createArtifactsStores({
        storage: data.storage,
        blobCacheBytes: 1024 * 1024,
        repository: {
          ...repo,
          fetchObjects: (input) =>
            remote.fetchObjects({
              ...input,
              onRetainedBytes: (bytes) => {
                peak = Math.max(peak, bytes);
              },
              sink: {
                get: input.sink!.get,
                async put(object, temporary) {
                  writes++;
                  earlyWrite ||= received < history.packBytes;
                  await input.sink!.put(object, temporary);
                },
              },
            }),
        },
      });
    await stores.recover();
    assert.equal(await stores.refs.get(main), history.commits.at(-1));
    assert.ok(earlyWrite && writes > 50, "objects reach storage before the response finishes");
    const pack = responsePack(server.control.uploadReplies.at(-1)!);
    assert.ok(pack.length > maximumReplyBytes);
    assert.ok(deltaKinds(pack).has("ofs_delta"));
    assert.ok(peak < pack.length / 5, `retained ${peak} of ${pack.length} pack bytes`);
    const cached = [
      ...data.storage.sql.exec(
        "SELECT SUM(bytes) AS bytes FROM vault_git_objects WHERE type = 'blob'",
      ),
    ][0];
    assert.ok(Number(cached?.bytes ?? 0) <= 1024 * 1024);
    const drive = createDrive({ ...stores, author });
    assert.deepEqual(
      (await drive.history({ limit: 100 })).map((entry) => entry.oid),
      git(server.bare, "rev-list", "main").toString().trim().split("\n"),
    );
    for (const [version, at] of history.commits.entries())
      for (const file of [0, 4]) {
        const read = await drive.read({ at, path: `file-${file}.bin` });
        assert.ok(read);
        assert.deepEqual(Buffer.from(read.content), sampleBytes(version, file));
        assert.equal(
          read.blob,
          git(server.bare, "rev-parse", `${at}:file-${file}.bin`).toString().trim(),
        );
      }
    // Force REF_DELTA with the same real Git history. Bases still come back through SQLite.
    server.control.omitted = ["ofs-delta"];
    const second = storageFixture();
    t.after(() => second.close());
    await createArtifactsStores({
      storage: second.storage,
      repository: repo,
      blobCacheBytes: 0,
    }).recover();
    assert.ok(deltaKinds(responsePack(server.control.uploadReplies.at(-1)!)).has("ref_delta"));
    t.diagnostic(
      `peak retained bytes ${peak}; upload pack bytes ${pack.length}; bare pack bytes ${history.packBytes}`,
    );
  },
);

test("repeated forward REF_DELTAs spill to storage and resolve after their base arrives byte by byte", async () => {
  const data = storageFixture();
  try {
    const cache = createObjectCache(data.storage, 1024, Date.now),
      base = await writtenObject("blob", new TextEncoder().encode("abc")),
      delta = Buffer.from([3, 4, 0x90, 3, 1, 100]),
      body = Buffer.concat([
        Buffer.from("5041434b0000000200000003", "hex"),
        Buffer.from([0x76]),
        Buffer.from(base.oid, "hex"),
        deflateSync(delta),
        Buffer.from([0x76]),
        Buffer.from(base.oid, "hex"),
        deflateSync(delta),
        Buffer.from([0x33]),
        deflateSync(base.content),
      ]),
      pack = Buffer.concat([body, sha1(body)]),
      wire = Buffer.from(await rawResponse(pack).arrayBuffer());
    let at = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          if (at === wire.length) controller.close();
          else controller.enqueue(new Uint8Array(wire.subarray(at, ++at)));
        },
      }),
    );
    await fetchStream(response, false, {
      get: async (oid) => cache.load(oid) ?? null,
      put: cache.putFetched,
    });
    cache.endFetch(true);
    const oid = await objectId("blob", new TextEncoder().encode("abcd"));
    assert.equal(new TextDecoder().decode(cache.load(oid)?.content), "abcd");
    assert.equal(
      cache.load(await objectId("blob", new Uint8Array(delta))),
      undefined,
      "staged delta is removed",
    );
  } finally {
    data.close();
  }
});

test("bad checksums and truncated streams keep refs unchanged and retry the incomplete closure", async (t) => {
  const server = await backend();
  t.after(() => server.close());
  // A real commit, tree and blob; truncate after the commit has already reached SQLite.
  git(server.bare, "symbolic-ref", "HEAD", main);
  const { root, bare } = server;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const clone = join(root, "small");
  mkdirSync(clone);
  git(clone, "init", "--initial-branch=main");
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(clone, "note.md"), "kept bytes");
  git(clone, "add", ".");
  git(clone, "commit", "-m", "fixture");
  git(clone, "push", bare, "main");
  for (const mode of ["checksum", "truncated"] as const) {
    const data = storageFixture();
    try {
      server.control.transform = (path, body) => {
        if (!path.endsWith("git-upload-pack")) return body;
        const pack = responsePack(body);
        if (mode === "checksum") pack[pack.length - 1]! ^= 1;
        return bandedReply(mode === "truncated" ? pack.subarray(0, pack.length - 30) : pack);
      };
      const stores = createArtifactsStores({
        storage: data.storage,
        repository: repository(server),
        blobCacheBytes: 0,
      });
      await assert.rejects(
        stores.recover(),
        (error) =>
          error instanceof ProtocolError &&
          (mode === "checksum" ? /checksum/.test(error.message) : /Truncated/.test(error.message)),
      );
      assert.equal(await stores.refs.get(main), null);
      const incomplete = [...data.storage.sql.exec("SELECT oid FROM vault_fetch_incomplete")];
      assert.ok(incomplete.length > 0, "partial metadata was persisted but cannot become a have");
      for (const row of data.storage.sql.exec("SELECT oid FROM vault_git_objects")) {
        const object = await stores.objects.get(String(row.oid));
        assert.ok(object);
        assert.equal(await objectId(object.type, object.content), object.oid);
      }
      server.control.transform = null;
      const retry = createArtifactsStores({
        storage: data.storage,
        repository: repository(server),
        blobCacheBytes: 0,
      });
      await retry.recover();
      const drive = createDrive({ ...retry, author });
      assert.equal(
        new TextDecoder().decode((await drive.read({ path: "note.md" }))!.content),
        "kept bytes",
      );
      assert.deepEqual([...data.storage.sql.exec("SELECT oid FROM vault_fetch_incomplete")], []);
      assert.doesNotMatch(server.control.uploadRequests.at(-1)!.toString(), /have /);
    } finally {
      data.close();
    }
  }
});

test("ingestion evicts old cache entries while retaining bases until the pack finishes", async () => {
  const data = storageFixture();
  try {
    const cache = createObjectCache(data.storage, 4, Date.now),
      old = await writtenObject("blob", new TextEncoder().encode("old!")),
      base = await writtenObject("blob", new TextEncoder().encode("a delta base"));
    cache.save([old], false);
    await cache.putFetched(base);
    assert.equal(cache.load(old.oid), undefined, "old blob evicted during ingestion");
    assert.ok(cache.load(base.oid), "in-pack base is protected even above the cache limit");
    cache.endFetch(true);
    assert.equal(cache.load(base.oid), undefined, "pin is released when the pack finishes");
  } finally {
    data.close();
  }
});
