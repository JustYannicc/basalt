import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, hash } from "./production-ops/artifact.ts";
import { productionOperation, type OpsInput } from "./production-ops/client.ts";
import { openEnvelope } from "../src/pool/token.ts";

const target = "https://operator.example.test";
const signingKey = "ab".repeat(32);
const request: OpsInput = {
  target,
  signingKey,
  action: "migrate",
  mode: "apply",
  selection: "migration-v1",
  request: '{"accounts":["acc_proof"]}',
  recipient: "YQ==",
  planSha256: "1".repeat(64),
  go: `GO ${"1".repeat(64)}`,
};
const backup = { version: 1, sealed: { ciphertext: "encrypted" } };
const previous = {
  action: "dry-run",
  artifact: { sha256: request.planSha256 },
  backup,
  backupSha256: hash(`${canonical(backup)}\n`),
};

test("an apply requires the exact saved dry-run and uploaded backup before sending a signed request", async () => {
  let calls = 0;
  const send: typeof fetch = async (_url, init) => {
    calls++;
    const parsed: unknown = JSON.parse(String(init?.body));
    assert.ok(
      typeof parsed === "object" &&
        parsed !== null &&
        "envelope" in parsed &&
        typeof parsed.envelope === "string",
    );
    const signed = await openEnvelope(signingKey, "sbops1", parsed.envelope);
    assert.ok(
      typeof signed === "object" && signed !== null && "target" in signed && "operation" in signed,
    );
    assert.equal(signed.target, target);
    assert.deepEqual(signed.operation, {
      action: "apply",
      selection: "migration-v1",
      request: { accounts: ["acc_proof"] },
      recipient: "YQ==",
      artifact: previous.artifact,
      planSha256: request.planSha256,
      backupSha256: previous.backupSha256,
      go: request.go,
    });
    return Response.json({
      action: "apply",
      planSha256: request.planSha256,
      verification: { ok: true },
    });
  };
  for (const invalid of [
    request,
    { ...request, previous, go: "GO another-plan" },
    { ...request, previous: { ...previous, artifact: { sha256: "2".repeat(64) } } },
    { ...request, previous: { ...previous, backup: { changed: true } } },
    { ...request, previous: { ...previous, action: "apply" } },
  ])
    await assert.rejects(productionOperation(invalid, send));
  assert.equal(calls, 0);
  assert.equal((await productionOperation({ ...request, previous }, send)).action, "apply");
  assert.equal(calls, 1);
});

test("a refused response never exposes its private body or repeats the mutation", async () => {
  let calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    return new Response("private-provider-token", { status: 409 });
  };
  await assert.rejects(
    productionOperation({ ...request, previous }, send),
    (error: unknown) =>
      error instanceof Error && error.message === "Production operation refused with HTTP 409",
  );
  assert.equal(calls, 1);
});
