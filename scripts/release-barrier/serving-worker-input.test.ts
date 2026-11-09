import { reportRefusal } from "./refusal-report.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { freezeUpload } from "./version-request.ts";
import { preparedUpload } from "./fixture.ts";
import { containerPublication } from "./test/container-fixture.ts";
import { assertBaselineWorkerInput } from "./container.ts";
import { assertJournaledBaselineInput } from "./forward-worker-input.ts";
import { servingWorkerSettings } from "./serving-worker-input.ts";
import { BarrierRefusal } from "./manifest.ts";

const binding = (text: string) => ({ name: "POOL_IMAGE_HASH", type: "plain_text", text });
const baseline = [{ versionId: "serving", percentage: 100 }];
const serving = [{ id: "serving", placement: undefined, bindings: [binding("a".repeat(16))] }];

test("latest upload differs from serving: both frozen recovery hash and container pairing use serving bindings", async () => {
  const upload = preparedUpload("PoolWorker");
  upload.previousSettings!.bindings = [binding("b".repeat(16))];
  const { frozen } = containerPublication();
  // This is the refused production call before serving-version selection.
  assert.throws(
    () => assertBaselineWorkerInput(frozen, upload.previousSettings),
    /container-baseline-worker-input-unconfirmed/,
  );
  const worker = await freezeUpload(upload, baseline, serving);
  assert.equal(worker.baselineImageHash, "a".repeat(16));
  assertJournaledBaselineInput(frozen, servingWorkerSettings(serving, baseline), worker);
});

test("a genuine serving/container mismatch refuses with the exact field and safe values", () => {
  const { frozen } = containerPublication();
  assert.throws(
    () => assertBaselineWorkerInput(frozen, { bindings: [binding("c".repeat(16))] }),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.match(
        error.message,
        /bindings\.POOL_IMAGE_HASH expected=aaaaaaaaaaaa observed=cccccccccccc/,
      );
      assert.deepEqual(error.delta?.changed, [
        { path: "bindings.POOL_IMAGE_HASH", old: "a".repeat(12), new: "c".repeat(12) },
      ]);
      return true;
    },
  );
});

for (const mode of [
  "missing",
  "duplicate",
  "secret",
  "wrong-version",
  "incomplete",
  "split-conflict",
])
  test(`serving binding proof refuses ${mode}`, () => {
    const versions = structuredClone(serving);
    let current = baseline;
    if (mode === "missing") versions[0]!.bindings = [];
    if (mode === "duplicate") versions[0]!.bindings.push(binding("a".repeat(16)));
    if (mode === "secret") versions[0]!.bindings[0]!.type = "secret_text";
    if (mode === "wrong-version") versions[0]!.id = "unserved";
    if (mode === "incomplete") current = [{ versionId: "serving", percentage: 50 }];
    if (mode === "split-conflict") {
      current = [
        { versionId: "serving", percentage: 50 },
        { versionId: "other", percentage: 50 },
      ];
      versions.push({ id: "other", placement: undefined, bindings: [binding("b".repeat(16))] });
    }
    assert.throws(
      () => servingWorkerSettings(versions, current),
      (error) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.ok(error.delta?.changed.length);
        if (mode === "incomplete")
          assert.deepEqual(error.delta.changed, [
            { path: "servingVersions.trafficTotal", old: 100, new: 50 },
          ]);
        if (mode === "duplicate")
          assert.ok(
            error.delta.changed.some(
              (item) =>
                item.path.endsWith(".count") && "old" in item && item.old === 1 && item.new === 2,
            ),
          );
        return true;
      },
    );
  });

test("malformed coverage reaches the release error report with expected and observed values", async () => {
  let refusal: BarrierRefusal | undefined;
  try {
    servingWorkerSettings(serving, [{ versionId: "serving", percentage: 50 }]);
  } catch (error) {
    assert.ok(error instanceof BarrierRefusal);
    refusal = error;
  }
  assert.ok(refusal);
  const output: string[] = [];
  await reportRefusal(refusal, undefined, (line) => output.push(line));
  assert.match(output.join("\n"), /PoolWorker.*servingVersions\.trafficTotal.*100.*50/);
});
