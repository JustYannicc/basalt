import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeSchemaAdmission } from "./home-schema-admission.ts";
import type { HomeMigrationIdentity, HomeSchemaResult } from "./home-schema-operation.ts";

const identity: HomeMigrationIdentity = {
  candidate: "a".repeat(40),
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageConfigDigest: `sha256:${"b".repeat(64)}`,
  baselineImageDigest: `sha256:${"c".repeat(64)}`,
  sourceInputHash: "d".repeat(16),
  baselineInputHash: "e".repeat(16),
};
const info = {
  format_version: 1 as const,
  target_version: 16,
  required_indexes: ["idx_usage", "idx_charge"],
};
const before: HomeSchemaResult = {
  format_version: 1,
  target_version: 16,
  previous_version: null,
  applied_version: 15,
  status: "pending",
  indexes_checked: false,
  pending_indexes: [],
  reason: "schema_pending",
};
const transition = {
  baselineInputHash: identity.baselineInputHash,
  candidateInputHash: identity.sourceInputHash,
  fromVersions: [15, 16],
  targetVersion: 16,
  requiredIndexes: [...info.required_indexes],
};

async function declarations(context: { after(fn: () => Promise<void>): void }, value: unknown) {
  const root = await mkdtemp(join(tmpdir(), "home-schema-admission-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "scripts/release-barrier");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "home-schema-admissions.json"), JSON.stringify(value));
  return homeSchemaAdmission(root);
}

test("only the exact reviewed source pair, versions and native index registry admit a migration", async (context) => {
  const admit = await declarations(context, { format_version: 1, transitions: [transition] });
  assert.equal(admit(identity, info, before), true);
  assert.equal(
    admit(identity, { ...info, required_indexes: [...info.required_indexes].reverse() }, before),
    true,
  );
  assert.equal(admit(identity, info, { ...before, applied_version: 16 }), true);
  for (const change of [{ sourceInputHash: "f".repeat(16) }, { baselineInputHash: "f".repeat(16) }])
    assert.equal(admit({ ...identity, ...change }, info, before), false);
  for (const applied_version of [null, 14, 17])
    assert.equal(admit(identity, info, { ...before, applied_version }), false);
  assert.equal(admit(identity, { ...info, target_version: 17 }, before), false);
  assert.equal(admit(identity, { ...info, required_indexes: ["idx_usage"] }, before), false);
  assert.equal(
    admit(identity, { ...info, required_indexes: ["idx_usage", "idx_other"] }, before),
    false,
  );
});

test("no approved pair refuses every migration and malformed admission cannot silently authorize", async (context) => {
  const admit = await declarations(context, { format_version: 1, transitions: [] });
  assert.equal(admit(identity, info, before), false);
  for (const value of [
    { format_version: 2, transitions: [transition] },
    { format_version: 1, transitions: [{ ...transition, candidateInputHash: "bad" }] },
    { format_version: 1, transitions: [{ ...transition, fromVersions: [] }] },
    { format_version: 1, transitions: [{ ...transition, approval: true }] },
  ])
    await assert.rejects(declarations(context, value), /home-schema-admission-invalid/);
  const duplicate = await declarations(context, {
    format_version: 1,
    transitions: [{ ...transition, requiredIndexes: ["idx_usage", "idx_usage"] }],
  });
  assert.equal(duplicate(identity, info, before), false);
});

test("two reviewed serving baselines admit one candidate while stale candidates and other baselines refuse", async (context) => {
  const baselines = ["ef1236d5c3f08c04", "0e2ecb6f105a95f3"];
  const sourceInputHash = "c7646255244ef2e0";
  const admit = await declarations(context, {
    format_version: 1,
    transitions: baselines.map((baselineInputHash) => ({
      ...transition,
      baselineInputHash,
      candidateInputHash: sourceInputHash,
    })),
  });
  for (const baselineInputHash of baselines) {
    const current = { ...identity, baselineInputHash, sourceInputHash };
    for (const applied_version of [15, 16])
      assert.equal(admit(current, info, { ...before, applied_version }), true);
    for (const stale of [
      "0152ede472b6f78e",
      "cc52df39f1c5cd82",
      "ef1236d5c3f08c04",
      "2fe25d81b60b7025",
      "6842d68639bcd135",
      "4290c0e3ed44b007",
      "f0306fefc74fbf8d",
    ])
      assert.equal(admit({ ...current, sourceInputHash: stale }, info, before), false);
    assert.equal(admit(current, { ...info, target_version: 17 }, before), false);
    assert.equal(admit(current, { ...info, required_indexes: ["idx_usage"] }, before), false);
    assert.equal(admit(current, info, { ...before, applied_version: 14 }), false);
  }
  assert.equal(
    admit({ ...identity, sourceInputHash, baselineInputHash: "f".repeat(16) }, info, before),
    false,
  );
});

test("the combined b76 publication requires its b75 baseline and preserves both b75 transitions", async () => {
  const admit = await homeSchemaAdmission(fileURLToPath(new URL("../../", import.meta.url)));
  const native = {
    ...info,
    required_indexes: [
      "idx_billing_charge_usage_cover_v1",
      "idx_billing_charge_overview_time_v1",
      "idx_usage_billing_complete_v2",
      "idx_usage_summary_cursor_v1",
      "idx_usage_key_success_time_v1",
      "idx_billing_charge_key_usage_v1",
    ],
  };
  const combined = {
    ...identity,
    baselineInputHash: "c7646255244ef2e0",
    sourceInputHash: "5f82807410b4ebd6",
  };
  for (const applied_version of [15, 16])
    assert.equal(admit(combined, native, { ...before, applied_version }), true);
  for (const sourceInputHash of [
    "c7646255244ef2e0",
    "f10a204af47e623f",
    "349077fb12a21f30",
    "0152ede472b6f78e",
    "f0306fefc74fbf8d",
    "cc52df39f1c5cd82",
    "ef1236d5c3f08c04",
    "2fe25d81b60b7025",
    "6842d68639bcd135",
    "4290c0e3ed44b007",
  ])
    assert.equal(admit({ ...combined, sourceInputHash }, native, before), false);
  for (const baselineInputHash of ["ef1236d5c3f08c04", "0e2ecb6f105a95f3", "f".repeat(16)])
    assert.equal(admit({ ...combined, baselineInputHash }, native, before), false);
  for (const applied_version of [null, 14, 17])
    assert.equal(admit(combined, native, { ...before, applied_version }), false);
  assert.equal(admit(combined, { ...native, target_version: 17 }, before), false);
  assert.equal(
    admit(combined, { ...native, required_indexes: native.required_indexes.slice(1) }, before),
    false,
  );
  for (const baselineInputHash of ["ef1236d5c3f08c04", "0e2ecb6f105a95f3"])
    assert.equal(
      admit(
        { ...combined, baselineInputHash, sourceInputHash: "c7646255244ef2e0" },
        native,
        before,
      ),
      true,
    );
});

test("the rebased fleet publication requires the serving b77 image and rejects the frozen image", async () => {
  const admit = await homeSchemaAdmission(fileURLToPath(new URL("../../", import.meta.url)));
  const native = {
    ...info,
    required_indexes: [
      "idx_billing_charge_usage_cover_v1",
      "idx_billing_charge_overview_time_v1",
      "idx_usage_billing_complete_v2",
      "idx_usage_summary_cursor_v1",
      "idx_usage_key_success_time_v1",
      "idx_billing_charge_key_usage_v1",
    ],
  };
  const current = {
    ...identity,
    baselineInputHash: "5f82807410b4ebd6",
    sourceInputHash: "cb7def7a9c6a50ee",
  };
  for (const applied_version of [15, 16])
    assert.equal(admit(current, native, { ...before, applied_version }), true);
  for (const sourceInputHash of ["6435f34f5e3ed462", "5f82807410b4ebd6", "f".repeat(16)])
    assert.equal(admit({ ...current, sourceInputHash }, native, before), false);
  for (const baselineInputHash of ["ef1236d5c3f08c04", "0e2ecb6f105a95f3", "c7646255244ef2e0"])
    assert.equal(admit({ ...current, baselineInputHash }, native, before), false);
  for (const applied_version of [null, 14, 17])
    assert.equal(admit(current, native, { ...before, applied_version }), false);
  assert.equal(admit(current, { ...native, target_version: 17 }, before), false);
  assert.equal(
    admit(current, { ...native, required_indexes: native.required_indexes.slice(1) }, before),
    false,
  );
});
