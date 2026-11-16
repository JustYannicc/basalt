import assert from "node:assert/strict";
import { test } from "node:test";
import { previewReceipt, requireSuccessfulSmoke } from "./receipt.ts";

function smoke() {
  return {
    version: 1,
    mode: "preview",
    signIn: true,
    pool: true,
    cleanup: true,
    clients: ["claude", "codex"].map((client) => ({
      client,
      exit: 0,
      timeout: false,
      modelRequest: true,
      toolSearch: true,
      undo: true,
      revoke: true,
    })),
  };
}
const identity = { pullRequest: 17, head: "a".repeat(40), base: "b".repeat(40) };

test("only real smoke and verified remote teardown produce the safe merge receipt", () => {
  assert.deepEqual(previewReceipt(smoke(), identity, true), {
    version: 1,
    ...identity,
    smoke: true,
    teardown: true,
  });
  assert.throws(() => previewReceipt(smoke(), identity, false), /teardown/);
  assert.throws(() => previewReceipt(smoke(), { ...identity, head: "main" }, true), /exact PR/);
  assert.throws(() => previewReceipt(smoke(), { ...identity, pullRequest: 0 }, true), /exact PR/);
});

test("failed, skipped, duplicate, partial and unsafe smoke reports stay red", () => {
  for (const field of ["signIn", "pool", "cleanup"]) {
    assert.throws(() => requireSuccessfulSmoke({ ...smoke(), [field]: false }));
  }
  for (const index of [0, 1]) {
    for (const [field, value] of Object.entries({
      exit: null,
      timeout: null,
      modelRequest: false,
      toolSearch: false,
      undo: false,
      revoke: false,
    })) {
      const report = smoke();
      const broken = {
        ...report,
        clients: report.clients.map((client, position) =>
          position === index ? { ...client, [field]: value } : client,
        ),
      };
      assert.throws(() => requireSuccessfulSmoke(broken), `${index} ${field}`);
    }
  }
  for (const mutate of [
    (report: ReturnType<typeof smoke>) => ({
      ...report,
      clients: [report.clients[0], { ...report.clients[1], client: "claude" }],
    }),
    (report: ReturnType<typeof smoke>) => ({ ...report, clients: report.clients.slice(0, 1) }),
    (report: ReturnType<typeof smoke>) => ({ ...report, clients: report.clients.toReversed() }),
    (report: ReturnType<typeof smoke>) => ({
      ...report,
      clients: report.clients.map((client, index) =>
        index === 0 ? { ...client, stdout: "raw transcript" } : client,
      ),
    }),
    (report: ReturnType<typeof smoke>) => ({ ...report, origin: "unexpected field" }),
    (report: ReturnType<typeof smoke>) => ({ ...report, mode: "full" }),
  ]) {
    assert.throws(() => requireSuccessfulSmoke(mutate(smoke())));
  }
});

test("an explicit compiler acceptance candidate cannot use an ordinary or missing catalog receipt", () => {
  assert.throws(() => previewReceipt(smoke(), { ...identity, compilerAcceptance: true }, true));
  assert.throws(() =>
    previewReceipt(smoke(), { ...identity, compilerAcceptance: true }, true, { rows: [] }),
  );
  assert.throws(() => previewReceipt(smoke(), identity, true, { rows: [] }), /ordinary preview/);
});

test("v2 records only its verified live and fixture coverage plus plan-only revoked grant", async () => {
  const { scopedSmoke, poolEvidence } = await import("./test/scoped.ts");
  const { validateScopedPreviewReceipt } = await import("./scoped-receipt.ts");
  const { validatePreviewReceipt } = await import("../release-merge/policy.ts");
  const report = scopedSmoke();
  const receipt = previewReceipt(report, identity, true, undefined, poolEvidence());
  assert.equal(receipt.version, 2);
  assert.deepEqual(validateScopedPreviewReceipt(receipt, identity), []);
  assert.deepEqual(validatePreviewReceipt(receipt, identity), []);
  assert.throws(() => previewReceipt(report, identity, true), /grant/);
  for (const change of [
    { requests: 0 },
    { model: "gpt-6.1-sol" },
    { revoked: false },
    { unauthorized: false },
    { extraUsageDisabled: false },
  ]) {
    assert.ok(
      validateScopedPreviewReceipt(
        { ...receipt, poolGrant: { ...poolEvidence(), ...change } },
        identity,
      ).length > 0,
    );
  }
  for (const field of [
    "chatgptAuthPreserved",
    "refreshTokenUntouched",
    "toolSearch",
    "undo",
    "revoke",
  ]) {
    const coverage = scopedSmoke();
    Object.assign(coverage.clients[1]!, { [field]: false });
    assert.ok(validateScopedPreviewReceipt({ ...receipt, coverage }, identity).length > 0, field);
  }
  const mislabeled = scopedSmoke();
  mislabeled.clients[1]!.transport = "live";
  assert.ok(
    validateScopedPreviewReceipt({ ...receipt, coverage: mislabeled }, identity).length > 0,
  );
  assert.ok(
    validateScopedPreviewReceipt(
      { version: 2, ...identity, smoke: true, teardown: true, catalogAcceptance: {} },
      identity,
    ).length > 0,
  );
  assert.throws(
    () => previewReceipt(smoke(), { ...identity, compilerAcceptance: true }, true, {}),
    /scoped v2/,
  );
});
