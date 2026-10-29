import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

interface UsageRecord {
  id: string; failed: boolean; status_code: number; model: string; request_id: string;
  client: { api_key_id: number; user_id: number };
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
    async function waitForCount(count: number) {
      const deadline = Date.now() + 30_000;
      do {
        const items = await records();
        if (items.length >= count) return items;
        await delay(200);
      } while (Date.now() < deadline);
      assert.fail("Failed usage did not become durable");
    }
    const oldFailure = await fixture.model(key.key, "privacy-old", "fail");
    assert.equal(oldFailure.status, 400);
    assert.ok((await oldFailure.text()).includes(response), "upstream sent the response sentinel");
    const oldRows = await waitForCount(1);
    assert.ok(oldRows.some((row) => row.failed && row.client.api_key_id === key.keyId));
    const exposed = await fixture.diagnostics.scan(secrets);
    assert.ok(exposed.database > 0, "released binaries reproduce the durable leak before the fix");
    console.log("PASS: released Home reproduces diagnostic exposure; no content printed");

    await fixture.replaceImage(candidate);
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 });
    const retained = await records();
    assert.equal(retained.length, oldRows.length, "purge preserves usage counts");
    assert.ok(retained.every((row) => row.client.api_key_id === key.keyId && row.client.user_id === key.userId), "safe identity survives purge");
    const fingerprint = `sha256:${createHash("sha256").update(key.key).digest("hex")}`;
    assert.equal((await fetch(`${fixture.node}/v1/models`, { headers: { Authorization: `Bearer ${fingerprint}` } })).status, 401,
      "diagnostic identity is never an authentication credential");
    const failure = await fixture.model(key.key, "privacy-new", "fail");
    assert.equal(failure.status, 400);
    assert.ok((await failure.text()).includes(response));
    const rows = await waitForCount(oldRows.length + 1);
    assert.ok(rows.some((row) => row.failed && row.status_code === 400 && row.request_id && row.client.api_key_id === key.keyId));
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 });

    // An old writer can run after a forward-only step commits and before rollout finishes.
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    fixture.diagnostics.sql(`update usage set api_key=${quote(key.key)}, fail_body=${quote(response)},
      fail=jsonb_build_object('status_code',400,'body',${quote(response)}),
      payload=payload::jsonb || jsonb_build_object('api_key',${quote(key.key)},'fail',jsonb_build_object('body',${quote(prompt)}))
      where id=${Number(rows[0]!.id)}`);
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 }, "mixed-version writes remain sanitized");
    await fixture.replaceImage(candidate);
    assert.equal((await records()).length, rows.length, "repeating the step does not drop or duplicate usage");
    assert.deepEqual(await fixture.diagnostics.scan(secrets), { database: 0, files: 0, logs: 0 });
    console.log("PASS: upgrade, forced failure, mixed writer and repeated boot retain no diagnostic content or tokens");
  } finally {
    await fixture.close();
  }
});
