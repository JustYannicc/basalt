import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { SharingFixture } from "./sharing-fixture.ts";

// Codex and Claude also execute real synthetic streams in import.test.ts.
const providers = ["antigravity", "kimi", "kimi-ai", "xai", "devin", "meta"];

test("existing native provider catalogs and account IDs survive the pool image upgrade", { timeout: 180_000 }, async () => {
  const baseline = process.env.POOL_TEST_BASE_IMAGE ?? process.env.POOL_TEST_LEGACY_IMAGE;
  const candidate = process.env.POOL_TEST_IMAGE;
  assert.ok(baseline && candidate, "Build the baseline and candidate pool images");
  const fixture = new SharingFixture({ image: baseline, resourcePrefix: "basalt-provider-loaders" });
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init));
    const accounts: { id: string; provider: string; key: string; models: string[] }[] = [];
    async function models(key: string): Promise<string[]> {
      const deadline = Date.now() + 20_000;
      do {
        const response = await fetch(`${fixture.node}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
        const result = await response.json() as { data?: { id: string }[] };
        if (response.ok && result.data?.length) return result.data.map((item) => item.id).sort();
        await delay(100);
      } while (Date.now() < deadline);
      assert.fail("An existing provider did not reach its account-scoped model catalog");
    }
    for (const provider of providers) {
      const saved = await fixture.data<{ name: string }>("/credentials", "POST", {
        type: provider, email: `fixture-${provider}@example.invalid`, access_token: `synthetic-${provider}-token`,
        refresh_token: `synthetic-${provider}-refresh`, expired: "2099-01-01T00:00:00Z", expiry: "2099-01-01T00:00:00Z",
        project_id: "fixture-project", proxy_url: "http://127.0.0.1:1",
      });
      const id = saved.name.replace(/\.json$/, "");
      const pool = `fixture-loader-${provider}`;
      await new PoolHome(client, pool).add([id]);
      const key = await new ComputerHome(client).mint("fixture-loader-owner", pool, `fixture-${provider}`);
      accounts.push({ id, provider, key: key.key, models: await models(key.key) });
    }
    await fixture.replaceImage(candidate);
    const credentials = await fixture.data<{ files: { id: string; provider: string }[] }>("/credentials");
    for (const account of accounts) {
      assert.ok(credentials.files.some((item) => item.id === account.id && item.provider === account.provider), account.provider);
      assert.deepEqual(await models(account.key), account.models, account.provider);
    }
  } finally {
    await fixture.close();
  }
});
