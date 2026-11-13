import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const pool = "fixture-pool",
  owner = "fixture-owner",
  organization = "fixture-org";
const mapping = [
  { sourceAccountRef: "a".repeat(64), targetAccountId: "fixture-account", provider: "codex" },
];
const run = (args: string[]) =>
  new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/import-cpamp-bulk.ts", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (part) => {
      output += part;
    });
    child.stderr.on("data", (part) => {
      output += part;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
async function fixture(directory: string, target: string, count: number, large = false) {
  const file = join(directory, "source.jsonl"),
    accepted = join(directory, "accepted.ids.jsonl");
  const map = join(directory, "map.json"),
    descriptor = join(directory, "descriptor.json");
  const rows = Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      event_hash: hash(String(index)),
      timestamp: "2026-10-01T01:02:03.123456Z",
      failed: false,
      provider: "codex",
      account_ref: large ? "b".repeat(4096) : "a".repeat(64),
    }),
  );
  const raw = rows.join("\n"),
    sourceHash = hash(JSON.stringify([0, hash(raw)]));
  const sourceIdentity = hash(JSON.stringify(["usage-import-v1", pool, source]));
  const ids = rows.map((row) =>
    hash(
      JSON.stringify([
        sourceIdentity,
        hash(JSON.stringify(["cpamp-event-v1", JSON.parse(row).event_hash])),
      ]),
    ),
  );
  const mapRaw = JSON.stringify(mapping);
  const report: unknown[] = [
    {
      version: 1,
      target,
      caller: owner,
      source,
      sourceHash,
      format: "cpamp-v1-jsonl",
      accountMapHash: hash(mapRaw),
      accountMappings: mapping,
    },
  ];
  for (let offset = 0; offset < rows.length; offset += 200)
    report.push({
      page: offset / 200,
      input: hash(
        JSON.stringify({
          source,
          format: "cpamp-v1-jsonl",
          data: rows.slice(offset, offset + 200).join("\n"),
          offset: 0,
          accountMappings: mapping,
        }),
      ),
      ids: ids.slice(offset, offset + 200),
    });
  report.push({ complete: true, pages: Math.ceil(count / 200) });
  const acceptedRaw = report.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(file, raw, { mode: 0o600 });
  await writeFile(accepted, acceptedRaw, { mode: 0o600 });
  await writeFile(map, mapRaw, { mode: 0o600 });
  const prepare = [
    "prepare",
    "--file",
    file,
    "--accepted-manifest",
    accepted,
    "--accepted-sha256",
    hash(acceptedRaw),
    "--account-map-file",
    map,
    "--target",
    target,
    "--caller",
    owner,
    "--source",
    source,
    "--organization",
    organization,
    "--pool",
    pool,
    "--descriptor",
    descriptor,
  ];
  return { file, accepted, map, descriptor, prepare, raw, acceptedRaw, sourceHash, ids };
}

test("bulk CLI preserves accepted IDs, separates upload from approval, and stops uncertain or unsafe operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "basalt-bulk-cli-"));
  let target = "",
    wrongViewer = false,
    wrongMap = false,
    dropUpload = false;
  let expectedGuard: Record<string, unknown> | undefined;
  let current: Record<string, unknown> = {},
    definition: Record<string, unknown> = {};
  const operations: string[] = [],
    uploads = new Map<number, string>();
  let network = 0;
  const server = createServer(async (request, response) => {
    network++;
    assert.equal(request.headers.cookie, "fixture_cookie=private-cookie-sentinel");
    assert.equal(request.headers.origin, target);
    assert.equal(request.headers.authorization, undefined);
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/viewer") {
      response.end(JSON.stringify({ userId: wrongViewer ? "another-owner" : owner }));
      return;
    }
    assert.equal(
      request.url,
      `/api/organizations/${organization}/apps/${pool}/pool-usage/import/bulk`,
    );
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const input = JSON.parse(Buffer.concat(parts).toString());
    operations.push(input.operation);
    if (input.operation === "begin") {
      assert.equal(input.job, undefined);
      assert.deepEqual(input.manifest, definition.manifest);
      assert.deepEqual(input.accountMappings, mapping);
    } else assert.equal(input.job, definition.job);
    if (input.operation === "upload") {
      if (dropUpload) {
        response.destroy();
        return;
      }
      const previous = uploads.get(input.chunk);
      if (previous !== undefined) assert.equal(input.data, previous);
      uploads.set(input.chunk, input.data);
      current.uploadedChunks = uploads.size;
    }
    if (input.operation === "guard") {
      if (expectedGuard) assert.deepEqual(input.observation, expectedGuard);
      else {
        assert.equal(
          input.observation.ready,
          false,
          "the missing error fields must revoke readiness",
        );
        assert.equal(input.observation.observedAt, 0, "no fresh timestamp is invented");
      }
    }
    if (input.operation === "pause") {
      current.state = "paused";
      current.reason = "operator_paused";
    }
    if (input.operation === "approve") {
      assert.equal(input.manifestDigest, definition.manifestDigest);
      assert.equal(input.accountMappingDigest, definition.accountMappingDigest);
    }
    if (input.operation === "resume") {
      current.state = "completed";
      current.reason = null;
      current.committedChunks = 2;
      current.inserted = 5001;
    }
    response.end(
      JSON.stringify({ ...current, ...(wrongMap ? { accountMappingDigest: "0".repeat(64) } : {}) }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  target = `http://127.0.0.1:${address.port}`;
  const cookie = join(directory, "session"),
    guard = join(directory, "guard.json");
  await writeFile(cookie, "fixture_cookie=private-cookie-sentinel", { mode: 0o600 });
  const input = await fixture(directory, target, 5001);
  let receiptIndex = 0;
  const command = (name: string, extra: string[] = []) =>
    run([
      name,
      "--descriptor",
      input.descriptor,
      "--owner-session-file",
      cookie,
      "--receipts",
      join(directory, `receipt-${receiptIndex++}.jsonl`),
      ...extra,
    ]);
  try {
    const beforeFiles = await readdir(directory);
    const prepared = await run(input.prepare);
    assert.equal(prepared.code, 0, prepared.output);
    assert.equal(network, 0, "prepare never calls the network");
    assert.deepEqual(
      (await readdir(directory)).sort(),
      [...beforeFiles, "descriptor.json"].sort(),
      "no source copy is created",
    );
    const saved = JSON.parse(await readFile(input.descriptor, "utf8"));
    definition = saved.definition;
    const manifest = saved.definition.manifest;
    assert.equal(manifest.sourceHash, input.sourceHash);
    assert.equal(manifest.approvedManifestSha256, hash(input.acceptedRaw));
    assert.equal(manifest.totalRows, 5001);
    assert.deepEqual(
      manifest.chunks.map((chunk: { rows: number }) => chunk.rows),
      [5000, 1],
    );
    assert.equal(manifest.chunks[0].idsSha256, hash(JSON.stringify(input.ids.slice(0, 5000))));
    assert.equal((await stat(input.descriptor)).mode & 0o777, 0o600);
    current = {
      job: definition.job,
      state: "uploading",
      manifestDigest: definition.manifestDigest,
      accountMappingDigest: definition.accountMappingDigest,
      totalRows: 5001,
      totalChunks: 2,
      uploadedChunks: 0,
      committedChunks: 0,
      inserted: 0,
      existing: 0,
      reason: null,
    };
    const uploaded = await command("upload");
    assert.equal(uploaded.code, 0, uploaded.output);
    assert.deepEqual(operations, ["begin", "upload", "upload"]);
    assert.equal(uploads.size, 2);
    for (const [index, data] of uploads) {
      assert.equal(hash(data), manifest.chunks[index].sha256);
      assert.equal(Buffer.byteLength(data), manifest.chunks[index].bytes);
    }
    const beforeWrong = network;
    assert.equal(
      (await command("apply", ["--approve", "0".repeat(64), "--guard-file", guard])).code,
      1,
    );
    assert.equal(network, beforeWrong, "wrong approval stops before viewer or mutation");
    wrongViewer = true;
    const beforeViewer = operations.length;
    assert.equal((await command("status")).code, 1);
    assert.equal(operations.length, beforeViewer);
    wrongViewer = false;
    wrongMap = true;
    const beforeMap = operations.length;
    assert.equal(
      (
        await command("apply", [
          "--approve",
          String(definition.manifestDigest),
          "--guard-file",
          guard,
        ])
      ).code,
      1,
    );
    assert.deepEqual(
      operations.slice(beforeMap),
      ["status"],
      "map acknowledgement precedes guard or approval",
    );
    wrongMap = false;
    await writeFile(
      guard,
      JSON.stringify({
        observedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        ready: true,
        cpu: 1,
      }),
      { mode: 0o600 },
    );
    const beforeGuard = operations.length;
    const paused = await command("apply", [
      "--approve",
      String(definition.manifestDigest),
      "--guard-file",
      guard,
    ]);
    assert.equal(paused.code, 1, paused.output);
    assert.deepEqual(operations.slice(beforeGuard), ["status", "guard", "pause"]);
    const now = Date.now();
    expectedGuard = {
      observedAt: now,
      expiresAt: now + 90_000,
      ready: true,
      cpu: 5,
      poolErrors: 0,
      queryErrors: 0,
    };
    await writeFile(guard, JSON.stringify(expectedGuard));
    const beforeApply = operations.length;
    const applied = await command("apply", [
      "--approve",
      String(definition.manifestDigest),
      "--guard-file",
      guard,
    ]);
    assert.equal(applied.code, 0, applied.output);
    assert.deepEqual(operations.slice(beforeApply), ["status", "guard", "approve", "resume"]);
    assert.match(applied.output, /"state":"completed"/);
    dropUpload = true;
    const beforeDrop = operations.length;
    const uncertain = await command("upload");
    assert.equal(uncertain.code, 1);
    assert.deepEqual(
      operations.slice(beforeDrop),
      ["begin", "upload"],
      "uncertain upload is not retried",
    );
    assert.match(uncertain.output, /No automatic retry/);
    const receipts = await readFile(join(directory, `receipt-${receiptIndex - 1}.jsonl`), "utf8");
    const pending = receipts
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .at(-1);
    assert.equal(pending.operation, "upload");
    assert.equal(pending.phase, "request");
    assert.equal(
      (await stat(join(directory, `receipt-${receiptIndex - 1}.jsonl`))).mode & 0o777,
      0o600,
    );
    assert.doesNotMatch(receipts + uncertain.output + prepared.output, /private-cookie-sentinel/);
    const beforeChanged = network;
    await writeFile(input.file, input.raw + "\n{}\n");
    assert.equal((await command("upload")).code, 1);
    assert.equal(network, beforeChanged, "source changes stop before any network");
    await writeFile(input.file, input.raw);
    await writeFile(input.accepted, input.acceptedRaw + "{}\n");
    assert.equal((await command("upload")).code, 1);
    assert.equal(network, beforeChanged, "accepted-manifest changes stop before any network");
    await writeFile(input.accepted, input.acceptedRaw);
    assert.equal(await readFile(input.map, "utf8"), JSON.stringify(mapping));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("bulk descriptor stops coalescing at the byte limit before the row limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "basalt-bulk-bytes-"));
  try {
    const input = await fixture(directory, "https://fixture.invalid", 2000, true);
    const result = await run(input.prepare);
    assert.equal(result.code, 0, result.output);
    const descriptor = JSON.parse(await readFile(input.descriptor, "utf8"));
    const chunks: { bytes: number; rows: number }[] = descriptor.definition.manifest.chunks;
    assert.equal(chunks.length, 2);
    assert.equal(
      chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
      2000,
    );
    assert.ok(chunks.every((chunk) => chunk.bytes <= 8 * 1024 * 1024 && chunk.rows <= 5000));
    assert.equal(await readFile(input.accepted, "utf8"), input.acceptedRaw);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
