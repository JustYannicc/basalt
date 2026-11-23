import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  historyJournalActivationMigration,
  historySchemaMigrations,
} from "../../src/pool/model-history/schema.ts";

// The runner skips a step by name once a database records it, so an edited step never reaches a
// database that already ran it. A changed definition is a new step; a new step adds its digest here.
const pinned: Record<string, string> = {
  model_request_history_v1: "07f85cb02bc916ea8e10e6a25c1227ca78997170cfca13680e26d818e7bb834e",
  model_request_history_v2_app_attribution:
    "d92f4af2f8ad8f641258874a9cf34a019ebdb2654f4432a0aebc3409631b7619",
  model_request_history_v3_account_time:
    "d59f3b7f028de724f514bf97decf0cd03e063509589f73ca482d8cf1dd306629",
  model_request_history_v4_traffic_purpose:
    "a14d68576022edf049ec709209c72fd612c0b0302b164a32feb0e8cb127878c8",
  model_request_history_v5_change_revisions:
    "41337afdeb8cb14bb9c6de3507538dd02f8ea22713189a423b1614cf2b299b60",
  model_request_history_v6_bulk_import:
    "f6741237e71fd1afe375543a8deafd6db43001afc17349de65c0dc6c90f6d6c4",
  model_request_history_v7_terminal_integrity:
    "a90ecd3c704e42acbbe14a954fa67030f02d09136b5ff39dc266680c0d597442",
  model_request_history_v8_import_completion:
    "c301a62d8ba054835393c6fa8a6261621670ab26fdc7feada7ae57a7db9f1baf",
  model_request_history_v9_change_journal_prepare:
    "fe68268edac8b2e6deffcadde519f8e13f70160eb98e3f8aff342517b0fd608b",
  model_request_history_v11_indexed_row_invalidation:
    "c3841200b773ca34cb19d9db3f1f795885be66bc5e48c7cddf76956025e8890b",
  model_request_history_v12_change_feed_once_per_transaction:
    "a19e9a4269837d0150d0a440d87810df5e1ecbb7d912eefd4126805976309d37",
  model_request_history_v13_import_reconcile:
    "39084ecfca0e33a827117a0b51d0bfc8adb90b12f4c6efd6db1696160581bc2c",
  model_request_history_v15_usage_rollup:
    "2fd62938cdf4e6a9115936285f93f0a36ee3bc87f8ade6f26e61e8ec9cee8f2d",
  model_request_history_v16_usage_rollup_people:
    "a71f5d3631e5474e9d9760bd3797f514ff4e392a9cc071e4559f223cb977e9a4",
  // The journal activation cutover is registered apart from the ordered steps.
  model_request_history_v10_change_journal_activate:
    "b2791bd29dfea0456497f9be6cd6d7f80a528fca126463a8960631b5f4edeccc",
};

test("a registered history step's statements and order never change after it is merged", () => {
  const steps = [...historySchemaMigrations, historyJournalActivationMigration];
  const registered = Object.fromEntries(
    steps.map((step) => [
      step.name,
      createHash("sha256").update(JSON.stringify(step.statements)).digest("hex"),
    ]),
  );
  for (const [name, digest] of Object.entries(pinned))
    assert.equal(
      registered[name],
      digest,
      `${name} changed or was removed; add the change as a new step instead, never update an existing digest`,
    );
  // A partly migrated database runs its pending steps in registry order, so a fresh one must too.
  assert.deepEqual(
    steps.map((step) => step.name),
    Object.keys(pinned),
    "history steps keep their order; a new step is appended and pins its statement digest here",
  );
});
