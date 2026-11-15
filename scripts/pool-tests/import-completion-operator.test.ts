import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { metadataInput } from "../usage-import-stream.ts";
import { completionManifestProof } from "../usage-import-completion.ts";
import { runImportCompletion } from "../pool-import-completion.ts";
import { parseUsageImport } from "../../src/pool/model-history/import.ts";
import { insertRequests } from "../../src/pool/model-history/store.ts";
import { importCompletionSelection } from "../../src/pool/model-history/import-completion-contract.ts";
import { handleModelHistoryOperation } from "../../src/pool/model-history/operator.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const source = "11111111-2222-4333-8444-555555555555";

test("the completion operator verifies frozen source watermarks and never duplicates an uncertain finalize", async () => {
  const directory = await mkdtemp(join(tmpdir(), "completion-operator-"));
  try {
    await seriesFixture(async ({ db, schema }) => {
      const file = join(directory, "source.jsonl"),
        manifest = join(directory, "manifest.jsonl");
      const data =
        [1, 2]
          .map((id) =>
            JSON.stringify({
              source_id: id,
              event_hash: sha(`event-${id}`),
              timestamp: `2026-01-01T0${id}:00:00Z`,
              failed: false,
            }),
          )
          .join("\n") + "\n";
      await writeFile(file, data, { mode: 0o600 });
      const sourceHash = await (await metadataInput(file)).digest();
      const header = {
        version: 1,
        target: "https://fixture.invalid",
        caller: "fixture-owner",
        source,
        sourceHash,
        format: "cpamp-v1-jsonl",
        accountMapHash: sha("[]"),
        accountMappings: [],
      };
      const request = {
        source,
        format: "cpamp-v1-jsonl",
        data: data.trimEnd(),
        offset: 0,
        accountMappings: [],
      };
      const parsed = await parseUsageImport(request, { pool, person: header.caller });
      await insertRequests(db, parsed.records);
      await writeFile(
        manifest,
        [
          header,
          {
            page: 0,
            input: sha(JSON.stringify(request)),
            ids: parsed.records.map((row) => row.id),
          },
          { complete: true, pages: 1 },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n") + "\n",
        { mode: 0o600 },
      );
      const inputs = [{ file, manifest }];
      const proof = await completionManifestProof(inputs, { pool, source });
      assert.equal(proof.upperSourceId, "2");
      assert.equal(proof.verifiedRows, "2");
      const selection = importCompletionSelection({ pool, source, afterSourceId: "0", ...proof });
      const selectionPath = join(directory, "selection.json"),
        plan = join(directory, "plan.json");
      await writeFile(selectionPath, JSON.stringify(selection), { mode: 0o600 });
      const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
      assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
      url.searchParams.set("options", `-c search_path=${schema}`);
      let writes = 0,
        loseReply = true;
      const options = {
        worker: "fixture-pool",
        accountId: "f".repeat(32),
        selection: selectionPath,
        inputs,
        plan,
        connect: async () => ({
          env: {
            POOL_OPERATIONS: {
              fetch: async (request: Request) => {
                const body = await request.clone().json();
                const response = await handleModelHistoryOperation(request, url.toString());
                if (body.go === true) {
                  writes++;
                  assert.equal(response.status, 200);
                  if (loseReply) throw new Error("Reply lost after commit");
                }
                return response;
              },
            },
          },
          dispose: async () => {},
        }),
      };
      const preview = await runImportCompletion(options);
      assert.equal(preview.reconciled, true);
      await assert.rejects(runImportCompletion({ ...options, apply: true }), /Reply lost/);
      assert.equal(writes, 1);
      assert.equal(JSON.parse(await readFile(`${plan}.result.json`, "utf8")).status, "started");
      await assert.rejects(runImportCompletion({ ...options, apply: true }), { code: "EEXIST" });
      assert.equal(writes, 1);
      assert.equal(
        (await db.query("SELECT upper_source_id::text AS id FROM basalt_model_import_completion"))
          .rows[0]!.id,
        "2",
      );
      await writeFile(selectionPath, JSON.stringify({ ...selection, upperSourceId: "3" }));
      await assert.rejects(
        runImportCompletion({ ...options, plan: join(directory, "bad-plan.json") }),
        /upperSourceId differs/,
      );
      assert.equal(writes, 1);
      const tailFile = join(directory, "tail.jsonl"),
        tailManifest = join(directory, "tail-manifest.jsonl");
      const tailData = JSON.stringify({
        source_id: 3,
        event_hash: sha("event-3"),
        timestamp: "2026-01-01T03:00:00Z",
        failed: false,
      });
      await writeFile(tailFile, tailData + "\n", { mode: 0o600 });
      const tailHeader = { ...header, sourceHash: await (await metadataInput(tailFile)).digest() };
      const tailRequest = { ...request, data: tailData };
      const tailParsed = await parseUsageImport(tailRequest, { pool, person: header.caller });
      await insertRequests(db, tailParsed.records);
      await writeFile(
        tailManifest,
        [
          tailHeader,
          {
            page: 0,
            input: sha(JSON.stringify(tailRequest)),
            ids: tailParsed.records.map((row) => row.id),
          },
          { complete: true, pages: 1 },
        ]
          .map((x) => JSON.stringify(x))
          .join("\n") + "\n",
        { mode: 0o600 },
      );
      const cumulativeInputs = [...inputs, { file: tailFile, manifest: tailManifest }];
      const cumulative = await completionManifestProof(cumulativeInputs, { pool, source });
      assert.equal(cumulative.upperSourceId, "3");
      assert.equal(cumulative.verifiedRows, "3");
      await writeFile(
        selectionPath,
        JSON.stringify(
          importCompletionSelection({ pool, source, afterSourceId: "2", ...cumulative }),
        ),
      );
      const topup = {
        ...options,
        inputs: cumulativeInputs,
        plan: join(directory, "topup-plan.json"),
      };
      const topupPlan = await runImportCompletion(topup);
      assert.equal(topupPlan.contiguous, true);
      assert.equal(topupPlan.reconciled, true);
      loseReply = false;
      assert.equal((await runImportCompletion({ ...topup, apply: true })).status, "complete");
      assert.equal(writes, 2);
      assert.equal(
        (await db.query("SELECT upper_source_id::text AS id FROM basalt_model_import_completion"))
          .rows[0]!.id,
        "3",
      );
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
