import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("operator manifest binds the private account map before any apply request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basalt-import-map-"));
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const mapping = [
    { sourceAccountRef: "a".repeat(64), targetAccountId: "fixture-account", provider: "codex" },
  ];
  let requests = 0,
    applies = 0,
    acknowledges = true;
  const server = createServer(async (request, response) => {
    requests++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.deepEqual(input.accountMappings, mapping);
    applies += Number(input.mode === "apply");
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ids: ["b".repeat(64)],
        next: null,
        approval: "fixture-approval",
        inserted: input.mode === "apply" ? 1 : 0,
        ...(acknowledges
          ? { accountMappingDigest: hash(JSON.stringify(input.accountMappings)) }
          : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const credential = join(dir, "token"),
    source = join(dir, "source"),
    map = join(dir, "map"),
    report = join(dir, "report");
  const run = (args: string[]) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/import-cpamp.ts",
          "--target",
          `http://127.0.0.1:${address.port}`,
          "--pool-token-file",
          credential,
          "--caller",
          "fixture-owner",
          "--source",
          "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          "--file",
          source,
          ...args,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, output }));
    });
  try {
    await writeFile(credential, "fixture-token", { mode: 0o600 });
    await writeFile(source, "{}\n");
    const mapData = JSON.stringify(mapping);
    await writeFile(map, mapData, { mode: 0o600 });
    const dry = await run(["--account-map-file", map, "--report", report]);
    assert.equal(dry.code, 0, dry.output);
    const manifest = await readFile(report, "utf8");
    const header = JSON.parse(manifest.split("\n")[0]!);
    assert.deepEqual(header.accountMappings, mapping);
    assert.equal(header.accountMapHash, hash(mapData));
    assert.doesNotMatch(manifest, /fixture-token/);
    const args = ["--apply-report", report, "--approve", hash(manifest)];
    const before = requests;
    const omitted = await run([...args, "--receipts", join(dir, "omitted")]);
    assert.equal(omitted.code, 1);
    assert.equal(requests, before);
    await writeFile(map, JSON.stringify([{ ...mapping[0], targetAccountId: "changed-account" }]));
    const changed = await run([
      ...args,
      "--account-map-file",
      map,
      "--receipts",
      join(dir, "changed"),
    ]);
    assert.equal(changed.code, 1);
    assert.equal(requests, before, "a changed map is refused before network access");
    await writeFile(map, mapData);
    await chmod(map, 0o644);
    assert.equal((await run(["--account-map-file", map, "--report", join(dir, "public")])).code, 1);
    assert.equal(requests, before);
    await chmod(map, 0o600);
    acknowledges = false;
    const beforeLegacy = requests;
    const legacy = await run([
      ...args,
      "--account-map-file",
      map,
      "--receipts",
      join(dir, "legacy-server"),
    ]);
    assert.equal(legacy.code, 1);
    assert.match(legacy.output, /Server did not acknowledge/);
    assert.equal(requests, beforeLegacy + 1);
    assert.equal(applies, 0, "an older server cannot apply an ignored map");
    acknowledges = true;
    const applied = await run([
      ...args,
      "--account-map-file",
      map,
      "--receipts",
      join(dir, "applied"),
    ]);
    assert.equal(applied.code, 0, applied.output);
    assert.equal(requests, beforeLegacy + 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
