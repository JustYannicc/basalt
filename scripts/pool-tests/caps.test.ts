import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { brand } from "../../brand.ts";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { capMessage, rewriteCapResponse } from "../../src/pool/cap-message.ts";
import { readCap, setCap } from "../../src/pool/caps.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

test("real pinned Home/node: weekly cap, charges, refusal, clear and pool isolation", { timeout: 420_000 }, async () => {
  const fixture = new SharingFixture();
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init));
    const home = new ComputerHome(client);
    const providers = await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility");
    for (const [pool, provider] of [["pool-a", "fixture-p1"], ["own-pool", "fixture-p2"]]) {
      const credential = providers.find((row) => row.name === provider)!.keys[0]!;
      await new PoolHome(client, pool!).add([credential.id]);
    }
    assert.deepEqual(await fixture.data("/billing/settings"), { service_tier_source: "request", report_timezone: "UTC" });
    const member = "fixture-member";
    const legacyName = `${brand.setup.id}-${await digest(member)}`;
    await fixture.data("/users", "POST", { username: legacyName, credits_unlimited: true });
    const legacyId = (await fixture.users()).find((user) => user.username === legacyName)!.id;
    async function legacyKey(pool: string, computer: string) {
      const key = `${brand.setup.keyPrefix}${crypto.randomUUID()}`;
      await fixture.data("/access/api-keys", "POST", { api_key: key, display_name: `${brand.setup.id}:${computer}`,
        user_id: legacyId, channels: [await home.group(pool)], model_groups: [] });
      return { key, keyId: (await fixture.keys()).find((row) => row.api_key === key)!.api_key_id };
    }
    const shared = await legacyKey("pool-a", "shared-computer");
    const own = await legacyKey("own-pool", "own-computer");
    assert.ok((await fixture.keys()).filter((key) => [shared.keyId, own.keyId].includes(key.api_key_id)).every((key) => key.user_id === legacyId));
    async function turn(key: string, session: string, expected: string) {
      const response = await fixture.model(key, session);
      const rewritten = await rewriteCapResponse(response, "/v1/chat/completions");
      assert.equal(response, rewritten, "Successful streams must pass through unchanged");
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, new RegExp(`"content":"${expected}"`));
    }
    await turn(shared.key, "before-cap", "P1");
    console.log("PASS 1: uncapped member request succeeded through pinned node");
    // Node v8.0.40 internal/runtime/executor/helps/usage_helpers.go:78-85 reports the executor id;
    // Home v1.1.6 internal/home/models.go:332-347 uses compat display names in its catalog.
    // Price the captured producer identity so the fixture covers this pinned-version mismatch.
    let record: { provider: string; model: string } | undefined;
    const firstDeadline = Date.now() + 30000;
    while (!record && Date.now() < firstDeadline) {
      const page = await fixture.data<{ items: { provider: string; model: string }[] }>(`/usage/records?client_key_id=${shared.keyId}&limit=10`);
      record = page.items.find((row) => row.model === "fixture-model");
      if (!record) await delay(200);
    }
    assert.ok(record, "Pinned node must publish fixture usage");
    // Home v1.1.6 internal/cluster/management/billing.go:16-28 accepts a request price.
    await fixture.data("/billing/model-prices", "POST", { provider: record.provider, model: record.model,
      request_price: 0.02, source: "manual" });
    await setCap(client, member, "pool-a", 0.01);
    assert.ok(!(await fixture.users()).some((user) => user.id === legacyId));
    const migratedKeys = await fixture.keys();
    const ownUserId = migratedKeys.find((key) => key.api_key_id === own.keyId)!.user_id;
    assert.notEqual(migratedKeys.find((key) => key.api_key_id === shared.keyId)!.user_id, ownUserId);
    console.log("PASS migration: both legacy keys now own distinct pool users; legacy user deleted");
    await turn(shared.key, "cross-cap", "P1");
    const deadline = Date.now() + 30000;
    while ((await readCap(client, member, "pool-a"))!.used < 0.02 && Date.now() < deadline) await delay(200);
    const cap = (await readCap(client, member, "pool-a"))!;
    assert.equal(cap.used, 0.02, JSON.stringify(await fixture.data("/billing/charges?limit=10")));
    assert.equal(cap.remaining, 0);
    console.log("PASS 2: unlimited member accrued a fixture charge after the owner set the weekly cap");
    for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      const before = fixture.calls.length;
      const response = await fetch(`${fixture.node}${path}`, { method: "POST",
        headers: { Authorization: `Bearer ${shared.key}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "fixture-model", stream: true, max_tokens: 32, input: "Reply", messages: [{ role: "user", content: "Reply" }] }),
        signal: AbortSignal.timeout(20000) });
      const raw = await response.clone().text();
      console.log(`Node cap refusal ${path}: ${response.status} ${raw}`);
      assert.equal(response.status, 429, raw);
      const rewritten = await rewriteCapResponse(response, path);
      const body = await rewritten.json();
      assert.equal(body.error.message, capMessage);
      assert.equal(path === "/v1/messages" ? body.type : body.error.code, path === "/v1/messages" ? "error" : "user_period_limit_exceeded");
      assert.equal(fixture.calls.length, before, "Capped request must not reach upstream");
    }
    console.log("PASS 3: all three client protocols received the worker's cap rewrite with HTTP 429");
    await turn(own.key, "own-while-capped", "P2");
    assert.equal(await readCap(client, member, "own-pool"), null);
    const beforeSwitch = fixture.events.length;
    await home.rebind(shared.keyId, "own-pool", member);
    const patches = fixture.events.slice(beforeSwitch).filter((event) => event.method === "PATCH" && event.path.endsWith("/access/api-keys"));
    assert.equal(patches.length, 1);
    const key = (await fixture.keys()).find((key) => key.api_key_id === shared.keyId)!;
    assert.equal(key.user_id, ownUserId); assert.equal(key.api_key, shared.key);
    assert.deepEqual(key.channels, [await home.group("own-pool")]);
    const ownName = await backendUserName(member, "own-pool");
    assert.equal((await fixture.users()).find((user) => user.username === ownName)?.id, ownUserId);
    await turn(shared.key, "switch-while-capped", "P2");
    console.log("PASS 4: member's own pool remains uncapped; one PATCH moved the same key to its user and channel");
    await setCap(client, member, "pool-a", null);
    assert.equal(await readCap(client, member, "pool-a"), null);
    await home.rebind(shared.keyId, "pool-a", member);
    await turn(shared.key, "after-clear", "P1");
    console.log("PASS 5: clearing the cap restores requests in the original pool");
  } finally { await fixture.close(); }
});
