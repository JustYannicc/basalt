import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { storageFixture } from "../fixture.ts";
import { writtenObject } from "../shared/.generated/strata/git/write.js";
import { createFetchStaging } from "./fetch-staging.ts";
import { fetchStream } from "./fetch-stream.ts";
import { createObjectCache } from "./object-cache.ts";
import { RetainedBytes } from "./stream-window.ts";

const packHeader = (count: number) => {
  const header = Buffer.from("5041434b0000000200000000", "hex");
  header.writeUInt32BE(count, 8);
  return header;
};
const checksum = (body: Uint8Array) => createHash("sha1").update(body).digest();
const distanceBytes = (distance: number) => {
  const bytes = [distance & 127];
  while ((distance = Math.floor(distance / 128))) bytes.unshift(128 | (--distance & 127));
  return Buffer.from(bytes);
};
const contentAt = (index: number) => {
  const content = Buffer.alloc(4);
  content.writeUInt32BE(index);
  return content;
};

// Fixed-size HTTP chunks keep the fixture's backing buffer independent of the object count.
const smallObjects = (count: number, forwardBase?: string) => {
  const hash = createHash("sha1");
  let at = -1;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (at === count) {
          controller.enqueue(hash.digest());
          controller.close();
          return;
        }
        let bytes: Buffer;
        if (at === -1) {
          bytes = packHeader(count + (forwardBase ? 1 : 0));
          at = 0;
        } else {
          const entries: Buffer[] = [];
          for (const end = Math.min(at + 64, count); at < end; at++) {
            if (forwardBase)
              entries.push(
                Buffer.from([0x77]),
                Buffer.from(forwardBase, "hex"),
                deflateSync(Buffer.concat([Buffer.from([4, 4, 4]), contentAt(at + 1)])),
              );
            else entries.push(Buffer.from([0x34]), deflateSync(contentAt(at)));
          }
          if (forwardBase && at === count)
            entries.push(Buffer.from([0x34]), deflateSync(contentAt(0)));
          bytes = Buffer.concat(entries);
        }
        hash.update(bytes);
        controller.enqueue(new Uint8Array(bytes));
      },
    }),
  );
};

const rows = (data: ReturnType<typeof storageFixture>, table: string) =>
  Number([...data.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`)][0]?.count);
const assertCleared = (data: ReturnType<typeof storageFixture>) => {
  for (const table of ["vault_fetch_offsets", "vault_fetch_deltas", "vault_fetch_delta_parts"])
    assert.equal(rows(data, table), 0, `${table} is cleared`);
};

for (const mode of ["offsets", "pending deltas"])
  test(`tracked ${mode} bookkeeping stays flat from 5,000 to 50,000 objects`, async (t) => {
    const peaks: number[] = [],
      root = await writtenObject("blob", contentAt(0)),
      forward = mode === "pending deltas";
    for (const count of [5000, 50000]) {
      const data = storageFixture();
      try {
        let peak = 0,
          written = 0,
          staged = 0,
          baseReady = false;
        await fetchStream(
          smallObjects(count, forward ? root.oid : undefined),
          false,
          {
            staging: createFetchStaging(data.storage),
            get: async (oid) => (baseReady && oid === root.oid ? root : null),
            async put(object) {
              written++;
              // The pack's offset index lives in storage, not in memory: sample it as it grows.
              if (!forward && written % 1000 === 0)
                staged = Math.max(staged, rows(data, "vault_fetch_offsets"));
              if (object.oid === root.oid) {
                if (forward) assert.equal(rows(data, "vault_fetch_deltas"), count);
                baseReady = true;
              }
            },
          },
          (bytes) => {
            peak = Math.max(peak, bytes);
          },
        );
        assert.equal(written, count + (forward ? 1 : 0));
        if (!forward) assert.ok(staged >= count - 1000, `offsets staged: ${staged} of ${count}`);
        peaks.push(peak);
        assertCleared(data);
      } finally {
        data.close();
      }
    }
    assert.ok(peaks[1]! <= peaks[0]! + 4096, `retained bytes grew: ${peaks.join(", ")}`);
    t.diagnostic(`${mode} tracked retained bytes: 5k=${peaks[0]}, 50k=${peaks[1]}`);
  });

test("a 2,000-link forward REF / backward OFS chain takes linear base reads", async (t) => {
  const count = 2000,
    data = storageFixture();
  t.after(() => data.close());
  const root = await writtenObject("blob", contentAt(0)),
    entries = [packHeader(count + 1)];
  let offset = 12,
    previous = 0;
  for (let i = 1; i <= count; i++) {
    const delta = Buffer.concat([Buffer.from([4, 4, 4]), contentAt(i)]);
    const entry = Buffer.concat([
      Buffer.from([i === 1 ? 0x77 : 0x67]),
      i === 1 ? Buffer.from(root.oid, "hex") : distanceBytes(offset - previous),
      deflateSync(delta),
    ]);
    entries.push(entry);
    previous = offset;
    offset += entry.length;
  }
  entries.push(Buffer.from([0x34]), deflateSync(root.content));
  const body = Buffer.concat(entries),
    cache = createObjectCache(data.storage, 4, Date.now);
  let reads = 0,
    writes = 0,
    peakCache = 0;
  await fetchStream(new Response(Buffer.concat([body, checksum(body)])), false, {
    staging: createFetchStaging(data.storage),
    async get(oid) {
      reads++;
      return cache.load(oid) ?? null;
    },
    async put(object) {
      await cache.putFetched(object);
      writes++;
      const bytes = Number(
        [
          ...data.storage.sql.exec(
            "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM vault_git_objects WHERE type = 'blob'",
          ),
        ][0]?.bytes,
      );
      peakCache = Math.max(peakCache, bytes);
      assert.ok(bytes <= 4, `ingestion cache retained ${bytes} bytes`);
    },
  });
  cache.endFetch(true);
  assert.equal(writes, count + 1);
  const last = await writtenObject("blob", contentAt(count));
  assert.deepEqual(cache.load(last.oid)?.content, new Uint8Array(last.content));
  assert.ok(reads <= 2 * count + 1, `${reads} base reads for ${count} links`);
  assertCleared(data);
  t.diagnostic(`2,000-link chain: ${reads} base reads; peak cache ${peakCache} bytes, limit 4`);
});

test("staging clears failed fetches and abandoned work before a retry starts", async (t) => {
  const data = storageFixture();
  t.after(() => data.close());
  const staging = createFetchStaging(data.storage),
    abandoned = staging.begin(new RetainedBytes());
  abandoned.resolved(12, "a".repeat(40));
  abandoned.defer(
    30,
    { kind: "ref_delta", size: 3, headerLength: 21, baseOid: "b".repeat(40) },
    new Uint8Array([1, 1, 0]),
  );
  assert.equal(rows(data, "vault_fetch_offsets"), 1);
  assert.equal(rows(data, "vault_fetch_deltas"), 1);
  const retry = staging.begin(new RetainedBytes());
  assertCleared(data);
  retry.close();
  const body = Buffer.concat([
    packHeader(1),
    Buffer.from([0x77]),
    Buffer.alloc(20),
    deflateSync(Buffer.from([4, 4, 4, 1, 2, 3, 4])),
  ]);
  const sink = { staging, get: async () => null, put: async () => {} };
  await assert.rejects(
    fetchStream(new Response(Buffer.concat([body, checksum(body)])), false, sink),
    /Missing or cyclic delta base/,
  );
  assertCleared(data);
  await assert.rejects(
    fetchStream(new Response(Buffer.concat([body, Buffer.alloc(20)])), false, sink),
    /checksum/,
  );
  assertCleared(data);
  await fetchStream(smallObjects(1), false, sink);
  assertCleared(data);
});
