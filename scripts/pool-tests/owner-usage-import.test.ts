import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { signEnvelope } from "../../src/pool/token.ts";
import {
  handleOwnerUsageImport,
  ownerModelImportPath,
} from "../../src/pool/model-history/import-owner-http.ts";
import { parseUsageImport } from "../../src/pool/model-history/import.ts";
import { importAccountReference } from "../../src/pool/model-history/import-account-reference.ts";
import { accountAuthority, pool, seriesFixture } from "./series-fixture.ts";

const signingKey = "ab".repeat(32),
  owner = "fixture-owner";
const mapping = {
  sourceAccountRef: "a".repeat(64),
  targetAccountId: "current-credential",
  provider: "codex",
};
const event = {
  event_hash: "b".repeat(64),
  timestamp: "2026-05-05T11:32:18.619Z",
  failed: false,
  provider: "codex",
  model: "fixture-model",
  account_ref: mapping.sourceAccountRef,
  request_id: "fixture-request",
  input_tokens: "100",
  output_tokens: "10",
  total_tokens: "110",
};
const input = {
  source: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  format: "cpamp-v1-jsonl",
  accountMappings: [mapping],
  data: JSON.stringify(event),
  mode: "dry-run",
};
const payload = (input: object) => ({
  action: "importUsage",
  pool,
  organization: "fixture-org",
  owner,
  user: owner,
  expiresAt: Date.now() + 25_000,
  input,
});
const request = async (value: object, key = signingKey) =>
  new Request(`https://pool.example${ownerModelImportPath}`, {
    method: "POST",
    body: JSON.stringify({ envelope: await signEnvelope(key, "sbs1", value) }),
  });

test("owner import refuses forged, expired and non-owner assertions before touching history", async () => {
  const access = { signingKey, connectionString: undefined };
  for (const changed of [
    { user: "manager" },
    { user: "admin" },
    { action: "poolUsageSeries" },
    { expiresAt: Date.now() - 1000 },
    { expiresAt: Date.now() + 60_000 },
    { owner: "" },
    { organization: "" },
  ]) {
    const response = await handleOwnerUsageImport(
      await request({ ...payload(input), ...changed }),
      access,
    );
    assert.equal(response.status, 401);
  }
  assert.equal(
    (await handleOwnerUsageImport(await request(payload(input), "cd".repeat(32)), access)).status,
    401,
  );
  assert.equal(
    (
      await handleOwnerUsageImport(
        new Request(`https://pool.example${ownerModelImportPath}`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
        access,
      )
    ).status,
    401,
  );
});

test("owner pages preserve mapped identities and resume committed pages without changing attribution", async () => {
  await seriesFixture(async ({ db, schema }) => {
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    let targets = [
      { id: mapping.targetAccountId, provider: mapping.provider },
      { id: "other-credential", provider: "codex" },
    ];
    const access = {
      signingKey,
      connectionString: url.toString(),
      importAccounts: async () => targets,
    };
    const post = async (input: object, changes = {}) =>
      handleOwnerUsageImport(await request({ ...payload(input), ...changes }), access);
    const preview = await post(input);
    assert.equal(preview.status, 200, await preview.clone().text());
    const dry = await preview.json();
    assert.deepEqual(
      dry.ids,
      (await parseUsageImport(input, { pool, person: owner })).records.map((row) => row.id),
    );
    assert.equal(
      dry.accountMappingDigest,
      createHash("sha256")
        .update(JSON.stringify([mapping]))
        .digest("hex"),
    );
    assert.equal(
      (await db.query("SELECT count(*)::int n FROM basalt_model_requests")).rows[0].n,
      0,
    );
    assert.equal(
      (await post({ ...input, mode: "apply", approval: dry.approval }, { pool: "other-pool" }))
        .status,
      409,
    );
    for (const expected of [1, 0]) {
      const applied = await post({ ...input, mode: "apply", approval: dry.approval });
      assert.equal(applied.status, 200, await applied.clone().text());
      assert.equal((await applied.json()).inserted, expected);
    }
    const second = {
      ...input,
      data: JSON.stringify({
        ...event,
        event_hash: "c".repeat(64),
        request_id: "fixture-request-2",
      }),
    };
    const secondDry = await (await post(second)).json();
    assert.equal(
      (await (await post({ ...second, mode: "apply", approval: secondDry.approval })).json())
        .inserted,
      1,
    );
    const native = await accountAuthority();
    const saved = (
      await db.query(
        "SELECT id,account,request_id,attribution FROM basalt_model_requests ORDER BY id",
      )
    ).rows;
    assert.equal(saved.length, 2);
    for (const row of saved) {
      assert.equal(row.account, importAccountReference(native.visible));
      assert.equal(row.attribution, "import-owner");
    }
    assert.equal(
      (
        await post({
          ...input,
          accountMappings: [{ ...mapping, targetAccountId: "other-credential" }],
        })
      ).status,
      409,
    );
    targets = [];
    assert.equal(
      (await post(second)).status,
      400,
      "current target membership is checked on every page",
    );
  });
});
