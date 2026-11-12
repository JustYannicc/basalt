import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("owner sign-in applies an unchanged mapped manifest and resumes a partial import without double counting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "basalt-owner-import-"));
  const session = join(directory, "session"),
    token = join(directory, "transport");
  const sourceFile = join(directory, "source.jsonl"),
    mapFile = join(directory, "map.json");
  const reportFile = join(directory, "report.jsonl");
  const mapping = [
    { sourceAccountRef: "a".repeat(64), targetAccountId: "fixture-account", provider: "codex" },
  ];
  const retained = new Set<string>();
  let stopSecondPage = true,
    viewer = "fixture-owner",
    importCalls = 0,
    applies = 0;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const ownerRequest = request.url !== "/pool/v1/usage/import";
    if (ownerRequest) {
      assert.equal(request.headers.cookie, "fixture_session=private-owner-session");
      assert.equal(request.headers.authorization, undefined);
      if (request.url === "/api/viewer") {
        response.end(JSON.stringify({ userId: viewer }));
        return;
      }
      assert.equal(request.headers.origin, `http://127.0.0.1:${address.port}`);
      assert.equal(
        request.url,
        "/api/organizations/fixture-org/apps/fixture-pool/pool-usage/import",
      );
    } else assert.equal(request.headers.authorization, "Bearer fixture-transport");
    importCalls++;
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(input.source, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    assert.deepEqual(input.accountMappings, mapping);
    const ids = input.data.split("\n").map((line: string) => hash(line));
    const missing = ids.filter((id: string) => !retained.has(id));
    const approval = hash(input.data);
    if (input.mode === "apply") {
      assert.equal(input.approval, approval);
      applies++;
      if (stopSecondPage && ids.length === 1) {
        stopSecondPage = false;
        response.destroy();
        return;
      }
      for (const id of ids) retained.add(id);
    }
    response.end(
      JSON.stringify({
        ids,
        next: null,
        existing: ids.length - missing.length,
        inserted: input.mode === "apply" ? missing.length : 0,
        wouldInsert: missing.length,
        accountMappingDigest: hash(JSON.stringify(mapping)),
        approval: input.mode === "dry-run" ? approval : null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const common = [
    "scripts/import-cpamp.ts",
    "--target",
    `http://127.0.0.1:${address.port}`,
    "--caller",
    "fixture-owner",
    "--source",
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "--file",
    sourceFile,
    "--account-map-file",
    mapFile,
  ];
  const ownerArgs = [
    "--owner-session-file",
    session,
    "--organization",
    "fixture-org",
    "--pool",
    "fixture-pool",
  ];
  const run = (args: string[]) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [...common, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
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
    await writeFile(session, "fixture_session=private-owner-session", { mode: 0o600 });
    await writeFile(token, "fixture-transport", { mode: 0o600 });
    await writeFile(mapFile, JSON.stringify(mapping), { mode: 0o600 });
    await writeFile(
      sourceFile,
      Array.from({ length: 201 }, (_, id) => JSON.stringify({ id })).join("\n"),
    );
    const dry = await run(["--pool-token-file", token, "--report", reportFile]);
    assert.equal(dry.code, 0, dry.output);
    const manifest = await readFile(reportFile, "utf8");
    const approved = ["--apply-report", reportFile, "--approve", hash(manifest)];
    const first = await run([
      ...ownerArgs,
      ...approved,
      "--receipts",
      join(directory, "partial.jsonl"),
    ]);
    assert.equal(first.code, 1);
    assert.equal(retained.size, 200);
    assert.equal(applies, 2, "the uncertain second request is not retried");
    const resumed = await run([
      ...ownerArgs,
      ...approved,
      "--receipts",
      join(directory, "resumed.jsonl"),
    ]);
    assert.equal(resumed.code, 0, resumed.output);
    assert.match(resumed.output, /"inserted":1/);
    assert.equal(retained.size, 201);
    assert.equal(
      await readFile(reportFile, "utf8"),
      manifest,
      "switching auth preserves the accepted manifest",
    );
    const receipts = await readFile(join(directory, "resumed.jsonl"), "utf8");
    assert.equal(JSON.parse(receipts.split("\n")[1]!).result.inserted, 0);
    assert.equal(JSON.parse(receipts.split("\n")[2]!).result.inserted, 1);
    assert.doesNotMatch(
      receipts + first.output + resumed.output,
      /private-owner-session|fixture-transport/,
    );
    assert.doesNotMatch(receipts, /"approval":"/);
    const before = importCalls;
    viewer = "another-owner";
    assert.equal(
      (await run([...ownerArgs, "--report", join(directory, "wrong-owner.jsonl")])).code,
      1,
    );
    assert.equal(importCalls, before, "wrong signed-in identity fails before importing any page");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
