import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

interface UsageRecord {
  id: string; session_id: string; failed: boolean; status_code: number; provider: string; model: string; request_id: string;
  client: { api_key_id: number; user_id: number };
  billing: { amount: number | null; matched_price_rule: string | null };
}

interface Charge {
  id: string; amount: number; matched_price_rule: string; price_snapshot: unknown;
  input_tokens: number; output_tokens: number; cache_tokens: number;
  balance_before: number; balance_after: number;
}

test("privacy upgrade purges released failure content and rejects future old-writer capture", { timeout: 420_000 }, async () => {
  const legacy = process.env.POOL_TEST_LEGACY_IMAGE, candidate = process.env.POOL_TEST_IMAGE;
  assert.ok(legacy && candidate, "Build the runtime and legacy-runtime image targets before this upgrade test");
  const prompt = "fail-request-private-prompt-739185", response = "private-response-and-header-620495";
  const fixture = new SharingFixture({ image: legacy, resourcePrefix: "basalt-privacy", failureContent: prompt, failureResponse: response });
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init));
    const providers = await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility");
    await new PoolHome(client, "privacy-pool").add([providers.find((item) => item.name === "fixture-p1")!.keys[0]!.id]);
    const key = await new ComputerHome(client).mint("privacy-person", "privacy-pool", "privacy-computer");
    const secrets = [prompt, response, key.key, "Bearer fixture-p1"];
    const records = () => fixture.data<{ items: UsageRecord[] }>("/usage/records?limit=200").then((page) => page.items);
    async function waitForCount(count: number, ready: (items: UsageRecord[]) => boolean = () => true) {
      const deadline = Date.now() + 30_000;
      do {
        const items = await records();
        if (items.length >= count && ready(items)) return items;
        await delay(200);
      } while (Date.now() < deadline);
      assert.fail("Failed usage did not become durable");
    }
    const oldFailure = await fixture.model(key.key, "privacy-old", "fail");
    assert.equal(oldFailure.status, 400);
    assert.ok((await oldFailure.text()).includes(response), "upstream sent the response sentinel");
    const failedRows = await waitForCount(1);
    assert.ok(failedRows.some((row) => row.failed && row.client.api_key_id === key.keyId));
    const producer = failedRows.find((row) => row.failed)!;
    await fixture.data("/billing/model-prices", "POST", { provider: producer.provider, model: producer.model,
      request_price: 0.02, source: "manual" });
    const success = await fixture.model(key.key, "privacy-priced-before-upgrade");
    assert.equal(success.status, 200);
    await success.text();
    const oldRows = await waitForCount(failedRows.length + 1, (items) => items.some((row) => row.billing.amount === 0.02));
    async function billingSnapshot() {
      const page = await fixture.data<{ items: Charge[]; total: number }>(`/billing/charges?user_id=${key.userId}&limit=200`);
      const charges = page.items.map(({ id, amount, matched_price_rule, price_snapshot, input_tokens,
        output_tokens, cache_tokens, balance_before, balance_after }) => ({ id, amount, matched_price_rule,
        price_snapshot, input_tokens, output_tokens, cache_tokens, balance_before, balance_after })).sort((a, b) => a.id.localeCompare(b.id));
      return { charges, count: page.total, amount: charges.reduce((sum, charge) => sum + charge.amount, 0) };
    }
    const billingBefore = await billingSnapshot();
    assert.equal(billingBefore.amount, 0.02);
    assert.ok(billingBefore.charges.some((charge) => charge.amount === 0.02 && charge.matched_price_rule !== "default:zero" && charge.price_snapshot));
    const exposed = await fixture.diagnostics.scan(secrets);
    assert.ok(exposed.database > 0, "released binaries reproduce the durable leak before the fix");
    console.log("PASS: released Home reproduces diagnostic exposure; no content printed");

    await fixture.replaceImage(candidate);
    await fixture.diagnostics.waitForPrivacy();
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 });
    const retained = await records();
    assert.equal(retained.length, oldRows.length, "purge preserves usage counts");
    assert.ok(retained.every((row) => row.client.api_key_id === key.keyId && row.client.user_id === key.userId), "safe identity survives purge");
    assert.deepEqual(await billingSnapshot(), billingBefore, "purge preserves amounts, price snapshots, token totals and balances");
    const newSuccess = await fixture.model(key.key, "privacy-priced-after-upgrade");
    assert.equal(newSuccess.status, 200);
    await newSuccess.text();
    const successfulRows = await waitForCount(oldRows.length + 1, (items) => items.filter((row) => row.billing.amount === 0.02).length === 2);
    assert.ok(successfulRows.some((row) => !row.failed && row.model === producer.model && row.client.api_key_id === key.keyId),
      "Home-selected model and client identity survive new successful usage");
    const billingAfter = await billingSnapshot();
    assert.equal(billingAfter.amount, 0.04, "new successful request still uses its price rule");
    for (const charge of billingBefore.charges) {
      assert.deepEqual(billingAfter.charges.find((row) => row.id === charge.id), charge, "new charging preserves historical charges");
    }
    const fingerprint = `sha256:${createHash("sha256").update(key.key).digest("hex")}`;
    assert.equal((await fetch(`${fixture.node}/v1/models`, { headers: { Authorization: `Bearer ${fingerprint}` } })).status, 401,
      "diagnostic identity is never an authentication credential");
    const failure = await fixture.model(key.key, "privacy-new", "fail");
    assert.equal(failure.status, 400);
    assert.ok((await failure.text()).includes(response));
    const rows = await waitForCount(successfulRows.length + 1);
    assert.ok(rows.some((row) => row.failed && row.status_code === 400 && row.request_id && row.client.api_key_id === key.keyId));
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 });

    // An old writer can run after a forward-only step commits and before rollout finishes.
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    fixture.diagnostics.sql(`update usage set api_key=${quote(key.key)}, fail_body=${quote(response)}, session_id=${quote(prompt)},
      fail=jsonb_build_object('status_code',400,'body',${quote(response)}),
      payload=payload::jsonb || jsonb_build_object('api_key',${quote(key.key)},'session_id',${quote(prompt)},'fail',jsonb_build_object('body',${quote(prompt)}))
      where id=${Number(rows[0]!.id)}`);
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 }, "mixed-version writes remain sanitized");
    // A database can already have a trigger from an earlier candidate. The
    // next boot must replace its function body while retaining the trigger.
    fixture.diagnostics.sql(`create or replace function home_diagnostics_metadata_only_usage_v1()
      returns trigger language plpgsql as $$ begin
        new.session_id := ''; new.payload := new.payload - 'session_id'; return new;
      end $$;`);
    await fixture.replaceImage(candidate);
    await fixture.diagnostics.waitForPrivacy();
    // The old writer and the query must agree on every canonical UUID shape.
    for (const session of ["7c9a1f40-209d-1b83-8f9c-eaef07268439", "7c9a1f40-209d-5b83-8f9c-eaef07268439",
      "7c9a1f40-209d-6b83-8f9c-eaef07268439", "00000000-0000-0000-0000-000000000000"]) {
      fixture.diagnostics.sql(`update usage set session_id=${quote(session)},
        payload=payload::jsonb || jsonb_build_object('session_id',${quote(session)}) where id=${Number(rows[0]!.id)}`);
      const found = await fixture.data<{ items: UsageRecord[] }>(`/usage/records?session_id=${session}&limit=200`);
      assert.equal(found.items.length, 1, "old-writer UUID remains queryable");
      assert.equal(found.items[0]!.session_id, session);
    }
    await fixture.replaceImage(candidate);
    assert.equal((await records()).length, rows.length, "repeating the step does not drop or duplicate usage");
    assert.deepEqual(await billingSnapshot(), billingAfter, "reboot preserves the same priced charges and totals");
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 });
    console.log("PASS: upgrade, forced failure, mixed writer and repeated boot retain no diagnostic content or tokens");
  } finally {
    await fixture.close();
  }
});
