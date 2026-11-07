import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageImportPage, UsageImportResult } from "../import-contract.ts";
import { prepareSelfImport } from "../../../src/pool/model-history/self-import.ts";
import { openImportSource, type ImportSource } from "./import-source.ts";
import { ImportSession, type ImportSend } from "./import-session.ts";

const row = (index: number) => ({
  event_hash: index.toString(16).padStart(64, "0"),
  timestamp: "2026-05-05T11:32:18.619000001Z",
  failed: false,
  model: "fixture-model",
  input_tokens: "100",
  output_tokens: "10",
  total_tokens: "110",
  raw_json: "private-message-sentinel",
});
const file = (length: number) =>
  new File([Array.from({ length }, (_, i) => JSON.stringify(row(i))).join("\n")], "metadata.jsonl");

function service() {
  const saved = new Map<string, unknown>();
  const calls: UsageImportPage[] = [];
  const send: ImportSend = async (input) => {
    calls.push(input);
    const parsed = await prepareSelfImport(input, {
      pool: "fixture-pool",
      caller: "fixture-caller",
    });
    const approval = JSON.stringify([input.format, input.data, input.offset]);
    if (input.mode === "apply")
      assert.equal(input.approval, approval, "apply must match the reviewed page");
    const existing = parsed.records.filter((record) => saved.has(record.id)).length;
    const inserted = input.mode === "apply" ? parsed.records.length - existing : 0;
    if (input.mode === "apply") for (const record of parsed.records) saved.set(record.id, record);
    return {
      ok: true,
      value: {
        mode: input.mode,
        pageDetails: parsed.records.length,
        totalDetails: parsed.totalDetails,
        existing,
        inserted,
        wouldInsert: parsed.records.length - existing,
        next: parsed.next,
        unpriced: parsed.records.length,
        approval: input.mode === "dry-run" ? approval : null,
        from: parsed.records[0]?.timestamp ?? null,
        to: parsed.records.at(-1)?.timestamp ?? null,
        aggregateOnlyNotImportable: parsed.aggregateOnlyNotImportable,
        indistinguishableDetails: parsed.indistinguishableDetails,
      } satisfies UsageImportResult,
    };
  };
  return { saved, calls, send };
}

test("JSONL previews the entire file without writes and applies only matching pages after Import", async () => {
  const backend = service(),
    session = new ImportSession(backend.send);
  await session.preview(await openImportSource(file(401)));
  assert.equal(session.snapshot.phase, "review");
  assert.equal(session.snapshot.total, 401);
  assert.equal(backend.saved.size, 0);
  assert.deepEqual(
    backend.calls.map(({ offset }) => offset),
    [0, 200, 400],
  );
  assert.ok(backend.calls.every(({ mode }) => mode === "dry-run"));
  assert.doesNotMatch(JSON.stringify(backend.calls), /private-message-sentinel/);
  await session.apply();
  assert.equal(session.snapshot.phase, "complete");
  assert.equal(session.snapshot.added, 401);
  assert.equal(backend.saved.size, 401);
  assert.deepEqual(
    backend.calls.filter(({ mode }) => mode === "apply").map(({ offset }) => offset),
    [0, 200, 400],
  );
  await session.preview(await openImportSource(file(401)));
  await session.apply();
  assert.equal(session.snapshot.added, 0);
  assert.equal(session.snapshot.existing, 401);
});

test("a full final JSONL page stops at local EOF despite the server continuation", async () => {
  const backend = service(),
    session = new ImportSession(backend.send);
  await session.preview(await openImportSource(file(200)));
  await session.apply();
  assert.equal(backend.calls.length, 3);
  assert.equal(session.snapshot.checked, 200);
  assert.equal(session.snapshot.phase, "complete");
});

test("pause finishes the current page; resume and a lost apply reply do not duplicate records", async () => {
  const backend = service();
  let loseReply = true;
  const session = new ImportSession(async (input) => {
    const result = await backend.send(input);
    if (input.mode === "apply" && loseReply) {
      loseReply = false;
      throw new Error("The reply was lost.");
    }
    if (input.mode === "apply" && input.offset === 200) session.pause();
    return result;
  });
  await session.preview(await openImportSource(file(401)));
  await session.apply();
  assert.equal(session.snapshot.phase, "error");
  assert.equal(backend.saved.size, 200);
  await session.apply();
  assert.equal(session.snapshot.phase, "paused");
  assert.equal(backend.saved.size, 400);
  assert.equal(session.snapshot.checked, 400);
  await session.apply();
  assert.equal(session.snapshot.phase, "complete");
  assert.equal(backend.saved.size, 401);
  assert.equal(session.snapshot.existing, 200);
});

test("changed content refuses before the first write; no preview means no apply", async () => {
  const backend = service(),
    session = new ImportSession(backend.send);
  await session.apply();
  assert.equal(backend.calls.length, 0);
  let data = JSON.stringify(row(1));
  const source: ImportSource = {
    label: "mutable fixture",
    format: "cpamp-v1-jsonl",
    async *pages() {
      yield { format: "cpamp-v1-jsonl", data, offset: 0 };
    },
  };
  await session.preview(source);
  data = JSON.stringify(row(2));
  await session.apply();
  assert.equal(session.snapshot.phase, "error");
  assert.match(session.snapshot.error!, /changed after/);
  assert.equal(backend.saved.size, 0);
});

test("legacy CPA keeps its bounded snapshot and returned offset, omitting messages and raw credentials", async () => {
  const backend = service(),
    session = new ImportSession(backend.send);
  const data = JSON.stringify(
    {
      version: 1,
      usage: {
        total_requests: 250,
        apis: {
          "private-api-key-sentinel": {
            models: {
              "fixture-model": {
                total_requests: 250,
                details: Array.from({ length: 201 }, () => ({
                  timestamp: "2020-01-01T00:00:00Z",
                  failed: false,
                    auth_index: "private-account-sentinel",
                  source: "private-filename-sentinel",
                  tokens: { input_tokens: 1 },
                  prompt: "private-message-sentinel",
                })),
              },
            },
          },
        },
      },
    },
    null,
    2,
  );
  await session.preview(await openImportSource(new File([data], "legacy.json")));
  assert.equal(session.snapshot.phase, "review");
  assert.equal(session.snapshot.total, 201);
  assert.equal(session.snapshot.aggregateOnly, "49");
  assert.deepEqual(
    backend.calls.map(({ offset }) => offset),
    [0, 200],
  );
  assert.equal(backend.calls[0]!.data, backend.calls[1]!.data);
  assert.doesNotMatch(JSON.stringify(backend.calls), /private-.*-sentinel/);
  await session.apply();
  assert.equal(backend.saved.size, 201);
});

test("UTF-8 boundaries, empty files, raw SQLite, mixed formats and oversized lines fail or stream safely", async () => {
  const text = JSON.stringify({ ...row(1), raw_json: "é".repeat(40_000) });
  const source = await openImportSource(new File([text], "unicode.jsonl"));
  const first = await source.pages().next();
  assert.equal(first.done, false);
  if (!first.done) assert.ok(first.value.data.length < 1000);
  await assert.rejects(openImportSource(new File([], "empty.jsonl")), /empty/);
  await assert.rejects(
    openImportSource(new File(["SQLite format 3\0"], "usage.sqlite")),
    /incomplete/,
  );
  await assert.rejects(
    openImportSource(new File([" ".repeat(8 * 1024 * 1024 + 1)], "large.jsonl")),
    /exceeds/,
  );
  const session = new ImportSession(service().send);
  await session.preview(
    await openImportSource(
      new File([JSON.stringify(row(1)), "\n", JSON.stringify({ usage_id: 5 })], "mixed.jsonl"),
    ),
  );
  assert.equal(session.snapshot.phase, "error");
});

test("invalid source errors never echo rows and nested payloads never leave the browser", async () => {
  await assert.rejects(
    openImportSource(new File(['{"private-message-sentinel"'], "invalid.json")),
    (error: Error) => {
      assert.doesNotMatch(error.message, /private-message-sentinel/);
      return true;
    },
  );
  const backend = service(),
    session = new ImportSession(backend.send);
  await session.preview(
    await openImportSource(
      new File(
        [JSON.stringify({ ...row(1), model: { prompt: "private-message-sentinel" } })],
        "nested.jsonl",
      ),
    ),
  );
  assert.equal(session.snapshot.phase, "error");
  assert.equal(backend.calls.length, 0);
});

test("cancelling the last preview page does not turn it into an approved import", async () => {
  const backend = service();
  const session = new ImportSession(async (input) => {
    const result = await backend.send(input);
    session.pause();
    return result;
  });
  await session.preview(await openImportSource(file(1)));
  assert.equal(session.snapshot.phase, "choose");
  await session.apply();
  assert.equal(backend.saved.size, 0);
});
