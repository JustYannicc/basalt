import type { DriveListPage, DriveSearchResult, DriveHistory } from "apps/contracts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getHeapStatistics } from "node:v8";
import { mkdir, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { volumeBackend } from "./volume-backend.ts";
import { blobId, corpusSeed, noteContent, notePath, searchNeedle } from "./large-corpus.ts";

const runtime = resolve(process.argv[2] ?? ".generated/obsidian-volume-smoke");
assert.ok(process.argv[3], "Supply an external report path before starting the volume proof");
const reportPath = resolve(process.argv[3]);
const notes = Number(process.argv[4] ?? 200),
  historical = notes / 5;
assert.ok(runtime.startsWith(resolve(".generated/obsidian-volume-")));
assert.ok(!reportPath.startsWith(runtime + "/"), "Evidence must outlive runtime cleanup");
assert.ok(Number.isSafeInteger(notes) && notes >= 100 && notes <= 25_000 && notes % 100 === 0);
const maximumDisk = 5_000_000_000,
  minimumFree = 20 * 1024 ** 3,
  started = Date.now();
const accepted = new Set<string>(),
  phases: { name: string; freeBytes: number; runtimeBytes: number }[] = [];
const report: Record<string, unknown> = {
  seed: corpusSeed,
  mode: notes === 25_000 ? "volume" : "smoke",
  notes,
  currentTextBytes: notes * 50_000,
  historicalTextBytes: historical * 50_000,
  maximumDisk,
  minimumFree,
  acceptedHeads: [],
  status: "running",
  pid: process.pid,
  node: process.version,
  heapLimit: getHeapStatistics().heap_size_limit,
};
let interrupted = false;
process.once("SIGINT", () => {
  interrupted = true;
});
process.once("SIGTERM", () => {
  interrupted = true;
});
report.head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
report.sourceHashes = Object.fromEntries(
  await Promise.all(
    [
      "src/drive/vault.ts",
      "src/drive/quota.ts",
      "src/drive/quota-limits.ts",
      "src/drive/io-quota.ts",
      "src/drive/object-cache.ts",
      "src/drive/tree-usage.ts",
      "src/drive/service.ts",
      "src/drive/search.ts",
      "src/drive/read.ts",
      "src/drive/shared/bun.lock",
      "e2e/obsidian/disk-store.ts",
      "e2e/obsidian/volume-backend.ts",
      "e2e/obsidian/volume-worker.fixture.ts.txt",
      "e2e/obsidian/runtime/bun.lock",
      "e2e/obsidian/large-corpus.ts",
      "e2e/obsidian/large-vault.ts",
    ].map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ]),
  ),
);
const directoryBytes = async (directory: string): Promise<number> => {
  let size = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    size += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return size;
};
await mkdir(runtime);
const boundary = async (name: string) => {
  const disk = await statfs(runtime),
    freeBytes = disk.bavail * disk.bsize,
    runtimeBytes = await directoryBytes(runtime);
  phases.push({ name, freeBytes, runtimeBytes });
  console.log(JSON.stringify({ phase: name, freeBytes, runtimeBytes }));
  if (freeBytes < minimumFree)
    throw new Error(`PHASE_PAUSED: ${name}, free ${freeBytes} bytes is below 20 GiB`);
  assert.ok(runtimeBytes <= maximumDisk, "The synthetic vault exceeded its complete disk envelope");
};
await boundary("runtime-setup");
const backend = await volumeBackend(runtime, process.argv[5] === "workerd");
report.runtime = backend.kind;
report.memoryScope =
  backend.kind === "workerd-sqlite-r2"
    ? "Node driver RSS; the separate workerd isolate is not measured by this counter"
    : "Node service and driver RSS";
try {
  await boundary("import");
  let vault = await backend.open(),
    head = vault.root;
  accepted.add(head);
  const apply = async (start: number, count: number, version: number) => {
    const result = await vault.service.apply({
      base: head,
      operation: `import-${version}-${start}`,
      edits: Array.from({ length: count }, (_, offset) => ({
        path: notePath(start + offset),
        content: noteContent(start + offset, version, notes),
      })),
    });
    assert.equal(result.state, "landed");
    head = result.oid;
    accepted.add(head);
    const usage = await vault.status();
    assert.ok(usage.cache.bytes <= usage.cache.limit);
    assert.ok(usage.retainedBytes <= 4_500_000_000);
    const memory = process.memoryUsage();
    console.log(
      JSON.stringify({
        batch: start,
        version,
        head,
        currentBytes: usage.currentBytes,
        retainedBytes: usage.retainedBytes,
        cacheBytes: usage.cache.bytes,
        ...memory,
      }),
    );
    if (interrupted) throw new Error("The owned volume proof was interrupted at a batch boundary");
    assert.ok(
      memory.rss <= 1_200_000_000,
      "The volume proof exceeded its shared-machine RSS allowance",
    );
  };
  for (let index = 0; index < notes; index += 100) await apply(index, 100, 0);
  const original = head;
  assert.equal((await vault.status()).currentBytes, notes * 50_000);
  report.importHead = original;
  await boundary("history");
  for (let index = 0; index < historical; index += 100)
    await apply(index, Math.min(100, historical - index), 1);
  assert.equal((await vault.status()).currentBytes, notes * 50_000);
  const current = head,
    before = await vault.status();
  report.beforeCacheLoss = before;
  await boundary("cache-loss-and-rebuild");
  await vault.clearCaches();
  assert.equal((await vault.status()).cache.bytes, 0);
  vault = await backend.rebuild();
  assert.equal((await vault.status()).currentBytes, before.currentBytes);
  assert.equal((await vault.status()).retainedBytes, before.retainedBytes);
  await boundary("complete-manifest");
  const expected = new Map<string, string>();
  for (let index = 0; index < notes; index++)
    expected.set(notePath(index), blobId(noteContent(index, index < historical ? 1 : 0, notes)));
  const observed = new Map<string, string>();
  const walk = async (path: string) => {
    let cursor: Awaited<ReturnType<typeof vault.service.list>>["next"] = null;
    do {
      const page: typeof DriveListPage.Type = await vault.service.list({
        at: current,
        path,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of page.entries) {
        if (entry.kind === "directory") await walk(entry.path);
        else {
          assert.equal(entry.oid, expected.get(entry.path));
          observed.set(entry.path, entry.oid);
        }
      }
      cursor = page.next;
    } while (cursor);
  };
  await walk("");
  assert.equal(observed.size, notes);
  assert.deepEqual([...observed.keys()].sort(), [...expected.keys()].sort());
  const manifest = [...observed]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, oid]) => `${path} ${oid} 50000\n`)
    .join("");
  await writeFile(reportPath + ".manifest", manifest);
  report.manifestSha256 = createHash("sha256").update(manifest).digest("hex");
  await boundary("cold-full-corpus-search");
  await vault.clearCaches();
  let cursor: Awaited<ReturnType<typeof vault.service.search>>["cursor"] = null,
    scanned = 0,
    pages = 0;
  const matches: string[] = [];
  do {
    const result: typeof DriveSearchResult.Type = await vault.service.search({
      query: searchNeedle,
      at: current,
      maxFiles: 50,
      ...(cursor ? { cursor } : {}),
    });
    scanned += result.scanned;
    pages++;
    matches.push(...result.matches.map((match) => match.path));
    assert.deepEqual(result.skippedBinary, []);
    cursor = result.cursor;
    if (!cursor) assert.equal(result.complete, true);
    assert.ok(pages <= notes, "Search did not make bounded forward progress");
  } while (cursor);
  assert.equal(scanned, notes);
  assert.deepEqual(matches, [notePath(notes - 1)]);
  report.search = { scanned, pages, matches, complete: true, at: current };
  await boundary("cold-edit-move-restore");
  const target = Math.min(42, historical - 1),
    path = notePath(target);
  assert.equal(
    (await vault.service.read({ path, at: original }))?.content,
    noteContent(target, 0, notes),
  );
  const edited = await vault.service.write({
    base: head,
    path,
    content: "A cold edit after cache loss",
    mode: "edit",
    operation: "cold-edit",
  });
  head = edited.oid;
  accepted.add(head);
  const restored = await vault.service.restore({
    base: head,
    from: original,
    path,
    operation: "cold-restore",
  });
  head = restored.oid;
  accepted.add(head);
  assert.equal(
    (await vault.service.read({ path, at: head }))?.content,
    noteContent(target, 0, notes),
  );
  const moved = await vault.service.move({
    base: head,
    from: path,
    to: "moved/cold.md",
    operation: "cold-move",
  });
  head = moved.oid;
  accepted.add(head);
  assert.equal(await vault.service.read({ path }), null);
  assert.equal(
    (await vault.service.read({ path: "moved/cold.md" }))?.content,
    noteContent(target, 0, notes),
  );
  await boundary("complete-history");
  const found = new Set<string>();
  let historyAt: string | undefined = head;
  while (historyAt) {
    const page: typeof DriveHistory.Type = await vault.service.history({
      at: historyAt,
      limit: 100,
    });
    assert.ok(page.length > 0);
    for (const commit of page) found.add(commit.oid);
    historyAt = page.at(-1)?.parents[0];
  }
  for (const oid of accepted)
    assert.ok(found.has(oid), "An accepted revision disappeared from canonical history");
  report.history = { accepted: accepted.size, reachable: found.size, complete: true };
  report.finalHead = head;
  report.finalUsage = await vault.status();
  report.r2 = { retainedBytes: (await vault.status()).retainedBytes };
  report.status = "passed";
} catch (error) {
  report.status = String(error).includes("PHASE_PAUSED") ? "paused" : "failed";
  report.error = String(error);
  process.exitCode = report.status === "paused" ? 75 : 1;
  console.error(error);
} finally {
  report.acceptedHeads = [...accepted];
  report.phases = phases;
  report.durationMs = Date.now() - started;
  report.maxRssBytes = process.resourceUsage().maxRSS * 1024;
  report.runtimeBytesBeforeCleanup = await directoryBytes(runtime);
  await backend.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await rm(runtime, { recursive: true, force: true });
  report.bulkDeleted = true;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, reportPath, bulkDeleted: true }));
}
