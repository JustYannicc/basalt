import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

test("streaming CLI approves exact IDs, stops uncertain apply, and safely replays acknowledged pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "basalt-cpamp-runner-"));
  const saved = new Set<string>();
  let requests = 0,
    dropSecondApply = true,
    applies = 0;
  const server = createServer(async (request, response) => {
    requests++;
    assert.equal(request.url, "/pool/v1/usage/import");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const ids = input.data.split("\n").map((line: string) => digest(line));
    const missing = ids.filter((id: string) => !saved.has(id));
    const approval = digest(input.data);
    if (input.mode === "apply") {
      assert.equal(input.approval, approval);
      for (const id of ids) saved.add(id);
      if (++applies === 2 && dropSecondApply) {
        dropSecondApply = false;
        response.destroy();
        return;
      }
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        ids,
        next: null,
        inserted: input.mode === "apply" ? missing.length : 0,
        wouldInsert: missing.length,
        approval: input.mode === "dry-run" ? approval : null,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const file = join(dir, "source.jsonl"),
    credential = join(dir, "token"),
    report = join(dir, "report.jsonl");
  const common = [
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
    file,
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
    await writeFile(credential, "fixture-token", { mode: 0o600 });
    await writeFile(file, Array.from({ length: 201 }, (_, n) => JSON.stringify({ n })).join("\n"));
    const dry = await run(["--report", report]);
    assert.equal(dry.code, 0, dry.output);
    assert.equal(saved.size, 0);
    const manifest = await readFile(report, "utf8"),
      approval = digest(manifest);
    assert.equal(manifest.trim().split("\n").length, 4);
    assert.doesNotMatch(manifest, /fixture-token/);
    const applyArgs = ["--apply-report", report, "--approve", approval];
    const first = await run([...applyArgs, "--receipts", join(dir, "receipt1")]);
    assert.equal(first.code, 1);
    assert.equal(saved.size, 201);
    assert.equal(applies, 2, "uncertain HTTP result is never retried automatically");
    assert.equal((await readFile(join(dir, "receipt1"), "utf8")).trim().split("\n").length, 2);
    const second = await run([...applyArgs, "--receipts", join(dir, "receipt2")]);
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /"inserted":0/);
    assert.equal(saved.size, 201);
    const before = requests;
    await writeFile(report, manifest.split("\n").slice(0, -2).join("\n") + "\n");
    const incomplete = await run([
      "--apply-report",
      report,
      "--approve",
      digest(await readFile(report, "utf8")),
      "--receipts",
      join(dir, "receipt3"),
    ]);
    assert.equal(incomplete.code, 1);
    assert.equal(requests, before, "incomplete approved manifest must fail before any request");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
