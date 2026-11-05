import assert from "node:assert/strict";
import { test } from "node:test";
import { backendUserName } from "../../src/pool/backend-users.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { PoolHome, HomeClient } from "../../src/pool/control.ts";
import { SharingFixture } from "./sharing-fixture.ts";

interface BillingSettings {
  allow_unpriced_models?: boolean;
  [key: string]: unknown;
}

interface ModelPrice {
  model: string;
  enabled: boolean;
}

function matchesModel(rule: string, model: string): boolean {
  const normalized = rule.trim().toLowerCase();
  const candidate = model.trim().toLowerCase();
  return normalized.endsWith("*")
    ? candidate.startsWith(normalized.slice(0, -1))
    : candidate === normalized;
}

async function enabledPrice(fixture: SharingFixture, model: string): Promise<boolean> {
  const page = await fixture.data<{ items: ModelPrice[] }>("/billing/model-prices");
  return page.items.some((rule) => rule.enabled && matchesModel(rule.model, model));
}

test(
  "real Home/node: unlimited pool key serves an unpriced model",
  { timeout: 420_000 },
  async () => {
    const fixture = new SharingFixture();
    try {
      await fixture.start();
      const client = new HomeClient((path, init) => fixture.fetchHome(path, init));
      const home = new PoolHome(client, "unpriced-pool");
      const computerHome = new ComputerHome(client);
      const provider = (
        await fixture.data<{ name: string; keys: { id: string }[] }[]>(
          "/config/api-keys/openai-compatibility",
        )
      ).find((row) => row.name === "fixture-p1");
      assert.ok(provider?.keys[0]?.id, "real Home must expose the fixture provider credential");
      await home.add([provider.keys[0].id]);

      const settings = await fixture.data<BillingSettings>("/billing/settings");
      if (Object.hasOwn(settings, "allow_unpriced_models")) {
        assert.equal(
          settings.allow_unpriced_models,
          true,
          "a Home version with the unpriced-model gate must start with the pool policy enabled",
        );
      }

      const model = "fixture-model";
      assert.equal(
        await enabledPrice(fixture, model),
        false,
        "the test model must have no enabled exact or wildcard price rule before inference",
      );

      const person = "fixture-unpriced-member";
      const userName = await backendUserName(person, "unpriced-pool");
      const key = await computerHome.mint(person, "unpriced-pool", "unpriced-model-test");
      const user = (
        await fixture.data<{
          users: { id: number; username: string; credits_unlimited: boolean }[];
        }>("/users")
      ).users.find((row) => row.id === key.userId);
      assert.ok(user, "the per-person, per-pool Home user must exist");
      assert.equal(user.username, userName);
      assert.equal(
        user.credits_unlimited,
        true,
        "the key must belong to the per-person, per-pool unlimited user",
      );
      const storedKey = (await fixture.keys()).find((row) => row.api_key_id === key.keyId);
      assert.ok(storedKey);
      assert.equal(storedKey.api_key, key.key);
      assert.equal(storedKey.user_id, key.userId);
      assert.deepEqual(storedKey.channels, [await computerHome.group("unpriced-pool")]);

      const previousCalls = fixture.calls.length;
      const response = await fixture.model(key.key, "unpriced-pool-request", false, model);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, /"content":"P1"/);
      assert.match(body, /data: \[DONE\]/);
      assert.deepEqual(
        fixture.calls.slice(previousCalls),
        ["Bearer fixture-p1"],
        "the successful pool inference must reach the real fixture provider exactly once",
      );
      assert.equal(
        await enabledPrice(fixture, model),
        false,
        "successful inference must not create a synthetic zero-price rule",
      );
    } finally {
      await fixture.close();
    }
  },
);
