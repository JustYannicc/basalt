import assert from "node:assert/strict";
import { test } from "node:test";
import { previewReceipt, requireSuccessfulSmoke } from "./receipt.ts";

function smoke(): any {
  return { version: 1, mode: "preview", signIn: true, pool: true, cleanup: true,
    clients: ["claude", "codex"].map(client => ({ client, exit: 0, timeout: false,
      modelRequest: true, toolSearch: true, undo: true, revoke: true })) };
}
const identity = { pullRequest: 17, head: "a".repeat(40), base: "b".repeat(40) };

test("only real smoke and verified remote teardown produce the safe merge receipt", () => {
  assert.deepEqual(previewReceipt(smoke(), identity, true), { version: 1, ...identity, smoke: true, teardown: true });
  assert.throws(() => previewReceipt(smoke(), identity, false), /teardown/);
  assert.throws(() => previewReceipt(smoke(), { ...identity, head: "main" }, true), /exact PR/);
  assert.throws(() => previewReceipt(smoke(), { ...identity, pullRequest: 0 }, true), /exact PR/);
});

test("failed, skipped, duplicate, partial and unsafe smoke reports stay red", () => {
  for (const field of ["signIn", "pool", "cleanup"]) {
    assert.throws(() => requireSuccessfulSmoke({ ...smoke(), [field]: false }));
  }
  for (const index of [0, 1]) {
    for (const [field, value] of Object.entries({ exit: null, timeout: null, modelRequest: false,
      toolSearch: false, undo: false, revoke: false })) {
      const report = smoke(); report.clients[index][field] = value;
      assert.throws(() => requireSuccessfulSmoke(report), `${index} ${field}`);
    }
  }
  for (const mutate of [
    (report: any) => { report.clients[1].client = "claude"; },
    (report: any) => { report.clients.pop(); },
    (report: any) => { report.clients.reverse(); },
    (report: any) => { report.clients[0].stdout = "raw transcript"; },
    (report: any) => { report.origin = "unexpected field"; },
    (report: any) => { report.mode = "full"; },
  ]) {
    const report = smoke(); mutate(report);
    assert.throws(() => requireSuccessfulSmoke(report));
  }
});
