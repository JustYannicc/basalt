// Artifacts has no local emulator. These tests use Git's official smart-HTTP CGI,
// git http-backend, served by Node over a temporary bare repo with receive-pack enabled.
// Miniflare runs the client code only; it does not emulate the Artifacts service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createGitRemote,
  AuthFailed,
  NotFound,
  Unavailable,
  ProtocolError,
  PushTooLarge,
  AtomicUnsupported,
} from "./transport.ts";
import { backend, git, token, responsePack, pkt } from "./test/backend.ts";
import { writtenObject, encodeTree, encodeCommit } from "../shared/.generated/strata/git/write.js";
import { readEntryHeader } from "../shared/.generated/strata/git/pack-entries.js";
import { inflateSync } from "node:zlib";
import type { GitObject } from "../shared/strata/types.ts";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

const ref = "refs/heads/main";
async function commit(message: string, parent?: string) {
  const blob = await writtenObject("blob", new TextEncoder().encode(message));
  const tree = await writtenObject(
    "tree",
    encodeTree([{ name: "note.md", mode: "100644", kind: "file", oid: blob.oid }]),
  );
  const head = await writtenObject(
    "commit",
    encodeCommit({
      tree: tree.oid,
      parents: parent ? [parent] : [],
      author: { name: "Fixture", email: "fixture@example.invalid", time: 1800000000 },
      message,
    }),
  );
  return { oid: head.oid, objects: [blob, tree, head] };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const server = await backend();
  t.after(() => server.close());
  return { ...server, remote: createGitRemote({ url: server.url, auth: async () => token }) };
}

test("empty advertisement, create main, fast-forward, stale CAS, empty pack, and atomic rejection", async (t) => {
  const { remote, bare, control } = await fixture(t);
  assert.deepEqual(Object.entries(await remote.refs()), []);
  assert.ok(remote.capabilities.includes("atomic"));
  assert.ok(remote.capabilities.includes("report-status"));
  const first = await commit("first");
  assert.deepEqual(
    await remote.push({ updates: [{ ref, old: null, next: first.oid }], objects: first.objects }),
    { applied: true, results: { [ref]: "ok" } },
  );
  assert.equal(git(bare, "rev-parse", "main").toString().trim(), first.oid);
  git(bare, "fsck", "--full");
  const second = await commit("second", first.oid);
  assert.equal(
    (
      await remote.push({
        updates: [{ ref, old: first.oid, next: second.oid }],
        objects: second.objects,
      })
    ).applied,
    true,
  );
  assert.equal(git(bare, "rev-parse", "main").toString().trim(), second.oid);
  const stale = await remote.push({
    updates: [{ ref, old: first.oid, next: second.oid }],
    objects: [],
  });
  assert.equal(stale.applied, false);
  assert.match(stale.results[ref]!, /failed|stale|lock/i);
  assert.equal(git(bare, "rev-parse", "main").toString().trim(), second.oid);
  const third = await commit("third", second.oid),
    other = "refs/heads/other";
  const atomic = await remote.push({
    updates: [
      { ref, old: first.oid, next: third.oid },
      { ref: other, old: null, next: third.oid },
    ],
    objects: third.objects,
  });
  assert.equal(atomic.applied, false);
  assert.notEqual(atomic.results[ref], "ok");
  assert.notEqual(atomic.results[other], "ok");
  assert.equal(git(bare, "rev-parse", "main").toString().trim(), second.oid);
  assert.equal(git(bare, "for-each-ref", "--format=%(refname)", other).length, 0);
  assert.equal(
    (await remote.push({ updates: [{ ref: other, old: null, next: second.oid }], objects: [] }))
      .applied,
    true,
  );
  assert.equal(git(bare, "rev-parse", "other").toString().trim(), second.oid);
  const accepted = await remote.push({
    updates: [
      { ref, old: second.oid, next: third.oid },
      { ref: other, old: second.oid, next: third.oid },
    ],
    objects: third.objects,
  });
  assert.equal(accepted.applied, true);
  assert.equal(git(bare, "rev-parse", "main").toString().trim(), third.oid);
  assert.equal(git(bare, "rev-parse", "other").toString().trim(), third.oid);
  assert.ok(
    control.pushBodies.every((body) =>
      body.includes(Buffer.from("\0report-status atomic side-band-64k")),
    ),
  );
  git(bare, "fsck", "--full");
});

async function cliHistory(root: string, bare: string) {
  const clone = join(root, "clone");
  git(root, "clone", bare, clone);
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.invalid");
  const common = Array.from(
    { length: 3000 },
    (_, i) => `Line ${i}: consistent content for delta compression`,
  ).join("\n");
  const commits: string[] = [];
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(clone, "history.md"), `${common}\nrevision ${i}\n`);
    git(clone, "add", "history.md");
    git(clone, "commit", "-m", `revision ${i}`);
    commits.push(git(clone, "rev-parse", "HEAD").toString().trim());
  }
  git(clone, "push", "origin", "main");
  git(bare, "gc", "--aggressive", "--prune=now");
  const packDir = join(bare, "objects", "pack");
  const idx = readdirSync(packDir).find((name) => name.endsWith(".idx"))!;
  assert.match(
    git(bare, "verify-pack", "-v", join(packDir, idx)).toString(),
    /chain length = [1-9]/,
  );
  return commits;
}
function deltaKinds(pack: Buffer) {
  const kinds = new Set<string>();
  let at = 12;
  for (let i = 0; i < pack.readUInt32BE(8); i++) {
    const header = readEntryHeader(new Uint8Array(pack), at);
    kinds.add(header.kind);
    const inflated = inflateSync(pack.subarray(at + header.headerLength, -20), {
      info: true,
    }) as unknown as { engine: { bytesWritten: number } };
    at += header.headerLength + inflated.engine.bytesWritten;
  }
  return kinds;
}
function matchesGit(bare: string, objects: GitObject[]) {
  for (const object of objects) {
    assert.equal(git(bare, "cat-file", "-t", object.oid).toString().trim(), object.type);
    assert.deepEqual(Buffer.from(object.content), git(bare, "cat-file", object.type, object.oid));
  }
}

test("fetch real CLI history byte-for-byte with OFS_DELTA and REF_DELTA packs", async (t) => {
  const { root, bare, remote, control } = await fixture(t),
    commits = await cliHistory(root, bare);
  const clone = join(root, "clone");
  git(clone, "tag", "-a", "fixture", "-m", "annotated fixture");
  git(clone, "push", "origin", "--tags");
  const wants = [commits.at(-1)!, git(bare, "rev-parse", "fixture").toString().trim()];
  for (const kind of ["ofs_delta", "ref_delta"]) {
    control.omitted = kind === "ref_delta" ? ["ofs-delta"] : [];
    const fetched = await remote.fetch({ wants });
    assert.equal(
      fetched.length,
      Number(git(bare, "rev-list", "--objects", "--all").toString().trim().split("\n").length),
    );
    matchesGit(bare, fetched);
    assert.ok(deltaKinds(responsePack(control.uploadReplies.at(-1)!)).has(kind));
  }
  assert.ok(
    control.uploadRequests.every(
      (request) => !/filter|include-tag|shallow|deepen/.test(request.toString()),
    ),
  );
});

test("thin REF_DELTA resolves external bases and verifies supplied base ids", async (t) => {
  const { root, bare, control, remote } = await fixture(t);
  const clone = join(root, "clone"),
    lookedUp: string[] = [];
  git(root, "clone", bare, clone);
  git(clone, "config", "user.name", "Fixture");
  git(clone, "config", "user.email", "fixture@example.invalid");
  const text = Array.from({ length: 3000 }, (_, i) => `Line ${i}: content for thin deltas`).join(
    "\n",
  );
  writeFileSync(join(clone, "history.md"), text);
  git(clone, "add", "history.md");
  git(clone, "commit", "-m", "base");
  git(clone, "push", "origin", "main");
  const have = git(clone, "rev-parse", "HEAD").toString().trim();
  control.omitted = ["ofs-delta"];
  writeFileSync(join(clone, "history.md"), text + "\nnext\n");
  git(clone, "add", "history.md");
  git(clone, "commit", "-m", "incremental");
  git(clone, "push", "origin", "main");
  const want = git(clone, "rev-parse", "HEAD").toString().trim();
  const base = async (id: string): Promise<GitObject | null> => {
    lookedUp.push(id);
    const type = git(bare, "cat-file", "-t", id).toString().trim() as GitObject["type"];
    return { oid: id, type, content: new Uint8Array(git(bare, "cat-file", type, id)) };
  };
  const fetched = await remote.fetch({ wants: [want], haves: [have], base });
  assert.match(control.uploadRequests.at(-1)!.toString(), /thin-pack/);
  assert.equal(fetched.length, 3);
  assert.ok(deltaKinds(responsePack(control.uploadReplies.at(-1)!)).has("ref_delta"));
  matchesGit(bare, fetched);
  assert.ok(fetched.some((object) => object.oid === want));
  assert.ok(lookedUp.length > 0, "real thin pack references a base outside the pack");
  await assert.rejects(
    remote.fetch({
      wants: [want],
      haves: [have],
      base: async (id) => ({
        oid: id,
        type: "blob",
        content: new TextEncoder().encode("wrong base"),
      }),
    }),
    /External delta base does not match/,
  );
  await assert.rejects(
    remote.fetch({ wants: [want], haves: [have], base: async () => null }),
    /Missing or cyclic delta base/,
  );
});

test("the bundled transport pushes and parses delta packs in the Workers runtime", async (t) => {
  const { root, bare, url, control } = await fixture(t),
    commits = await cliHistory(root, bare);
  const bundle = await build({
    entryPoints: [new URL("./test/worker.ts", import.meta.url).pathname],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*"],
    write: false,
  });
  const worker = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
  });
  t.after(() => worker.dispose());
  const response = await worker.dispatchFetch("http://transport.test", {
    method: "POST",
    body: JSON.stringify({ url, token, want: commits.at(-1)! }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const result = (await response.json()) as {
    result: { applied: boolean };
    commit: string;
    objects: Array<Omit<GitObject, "content"> & { content: number[] }>;
  };
  assert.equal(result.result.applied, true);
  assert.ok(deltaKinds(responsePack(control.uploadReplies[0]!)).has("ofs_delta"));
  assert.equal(git(bare, "rev-parse", "worker").toString().trim(), result.commit);
  matchesGit(
    bare,
    result.objects.map((object) => ({ ...object, content: Uint8Array.from(object.content) })),
  );
  git(bare, "fsck", "--full");
});

test("non-atomic server refuses multiple updates before POST; single update works without side band", async (t) => {
  const { remote, control } = await fixture(t),
    first = await commit("plain");
  control.omitted = ["atomic", "side-band-64k"];
  await assert.rejects(
    remote.push({
      updates: [
        { ref, old: null, next: first.oid },
        { ref: "refs/heads/second", old: null, next: first.oid },
      ],
      objects: first.objects,
    }),
    AtomicUnsupported,
  );
  assert.equal(control.pushes, 0);
  assert.equal(
    (await remote.push({ updates: [{ ref, old: null, next: first.oid }], objects: first.objects }))
      .applied,
    true,
  );
  assert.equal((await remote.fetch({ wants: [first.oid] })).length, 3);
});

test("object count, command bytes, file size, and whole push size fail before any HTTP request", async (t) => {
  const { remote, control } = await fixture(t),
    first = await commit("limit");
  const update = { ref, old: null, next: first.oid };
  await assert.rejects(
    remote.push({ updates: [update], objects: Array(50_001).fill(first.objects[0]) }),
    (error) => error instanceof PushTooLarge && error.objectCount === 50_001,
  );
  const updates = Array.from({ length: 9000 }, (_, i) => ({
    ...update,
    ref: `refs/heads/${String(i).padStart(45, "0")}`,
  }));
  await assert.rejects(
    remote.push({ updates, objects: [] }),
    (error) => error instanceof PushTooLarge && error.commandBytes > 1_048_576,
  );
  const tooBig = { ...first.objects[0]!, content: new Uint8Array(33_554_433) };
  await assert.rejects(
    remote.push({ updates: [update], objects: [tooBig] }),
    (error) => error instanceof PushTooLarge && error.largestObjectBytes === 33_554_433,
  );
  // Individually legal incompressible objects fit in 64 MiB raw, but not with pack and commands.
  const blobs = await Promise.all(
    [0, 1].map(async () => writtenObject("blob", new Uint8Array(randomBytes(33_540_000)))),
  );
  const manyUpdates = Array.from({ length: 150 }, (_, i) => ({
    ...update,
    ref: `refs/heads/${String(i).padStart(45, "0")}`,
  }));
  await assert.rejects(remote.push({ updates: manyUpdates, objects: blobs }), (error) => {
    assert.ok(error instanceof PushTooLarge);
    assert.ok(error.requestBytes > 67_108_864);
    assert.ok(
      error.packBytes <= 67_108_864,
      "pack alone fits; commands cross the whole-request limit",
    );
    assert.equal(error.requestBytes, error.commandBytes + error.packBytes);
    return true;
  });
  assert.equal(control.requests, 0);
});

test("Basic strips expiry, rotates auth, and maps HTTP failures without leaking credentials", async (t) => {
  const { url, control } = await fixture(t);
  let current = "art_v1_wrong?expires=4102444800",
    calls = 0;
  const remote = createGitRemote({
    url: url.replace("http://", "http://fixture:password@"),
    auth: async () => {
      calls++;
      return current;
    },
  });
  await assert.rejects(remote.refs(), (error) => {
    assert.ok(error instanceof AuthFailed);
    assert.doesNotMatch(error.message, /art_v1|password|http:/);
    return true;
  });
  current = token;
  await remote.refs();
  assert.equal(calls, 2);
  for (const [status, kind] of [
    [403, AuthFailed],
    [404, NotFound],
    [503, Unavailable],
    [400, ProtocolError],
    [307, ProtocolError],
  ] as const) {
    const before = control.requests;
    control.status = status;
    await assert.rejects(remote.refs(), kind);
    assert.equal(control.requests, before + 1);
  }
  const network = createGitRemote({
    url,
    auth: async () => token,
    fetch: async () => {
      throw new Error(`secret ${token}`);
    },
  });
  await assert.rejects(
    network.refs(),
    (error) => error instanceof Unavailable && !error.message.includes(token),
  );
});

test("fatal side band, unpack failure, missing statuses, and corrupt fetch packs are protocol errors", async (t) => {
  const { remote, control } = await fixture(t),
    first = await commit("corruption");
  await remote.push({ updates: [{ ref, old: null, next: first.oid }], objects: first.objects });
  for (const reply of [
    pkt(Buffer.concat([Buffer.from([3]), Buffer.from("fatal")])),
    pkt(Buffer.concat([Buffer.from([1]), pkt("unpack failed\n"), Buffer.from("0000")])),
    pkt(Buffer.concat([Buffer.from([1]), pkt("unpack ok\n"), Buffer.from("0000")])),
  ]) {
    control.transform = (path, body) => (path.endsWith("git-receive-pack") ? reply : body);
    await assert.rejects(
      remote.push({ updates: [{ ref, old: first.oid, next: first.oid }], objects: [] }),
      ProtocolError,
    );
  }
  control.transform = (path, body) => {
    if (path.endsWith("git-upload-pack")) {
      const corrupted = Buffer.from(body),
        signature = corrupted.indexOf("PACK");
      corrupted[signature + 10]! ^= 1;
      return corrupted;
    }
    return body;
  };
  await assert.rejects(remote.fetch({ wants: [first.oid] }), /Pack checksum mismatch/);
});
