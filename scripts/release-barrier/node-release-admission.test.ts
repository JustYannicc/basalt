import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { homeSchemaAdmission } from "./home-schema-admission.ts";
import type { HomeMigrationIdentity, HomeSchemaResult } from "./home-schema-operation.ts";

for (const { version, baselineInputHash, sourceInputHash } of [
  {
    version: "8.0.73",
    baselineInputHash: "36a7ce7f37bea4a5",
    sourceInputHash: "526fa60bed0df442",
  },
  {
    version: "8.0.74",
    baselineInputHash: "526fa60bed0df442",
    sourceInputHash: "3c69ffd86382c294",
  },
]) {
  test(`the ${version} node publication requires its reviewed source pair and unchanged Home schema`, async () => {
    const admit = await homeSchemaAdmission(fileURLToPath(new URL("../../", import.meta.url)));
    const identity: HomeMigrationIdentity = {
      candidate: "a".repeat(40),
      imageDigest: `sha256:${"a".repeat(64)}`,
      imageConfigDigest: `sha256:${"b".repeat(64)}`,
      baselineImageDigest: `sha256:${"c".repeat(64)}`,
      baselineInputHash,
      sourceInputHash,
    };
    const info = {
      format_version: 1 as const,
      target_version: 16,
      required_indexes: [
        "idx_billing_charge_usage_cover_v1",
        "idx_billing_charge_overview_time_v1",
        "idx_usage_billing_complete_v2",
        "idx_usage_summary_cursor_v1",
        "idx_usage_key_success_time_v1",
        "idx_billing_charge_key_usage_v1",
      ],
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
    for (const applied_version of [15, 16])
      assert.equal(admit(identity, info, { ...before, applied_version }), true);
    for (const change of [
      { baselineInputHash: "8bbfbb3d5c4466ba" },
      { baselineInputHash: "f".repeat(16) },
      { sourceInputHash: "8bbfbb3d5c4466ba" },
      { sourceInputHash: "f".repeat(16) },
      { baselineInputHash: sourceInputHash },
      { sourceInputHash: baselineInputHash },
    ])
      assert.equal(admit({ ...identity, ...change }, info, before), false);
    for (const applied_version of [null, 14, 17])
      assert.equal(admit(identity, info, { ...before, applied_version }), false);
    assert.equal(admit(identity, { ...info, target_version: 17 }, before), false);
    for (const required_indexes of [
      info.required_indexes.slice(1),
      [...info.required_indexes.slice(1), "idx_other"],
    ])
      assert.equal(admit(identity, { ...info, required_indexes }, before), false);
  });
}
