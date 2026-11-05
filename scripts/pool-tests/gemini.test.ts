import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { withProviderProduct } from "./provider-product.mjs";
import { HomeClient } from "../../src/pool/control.ts";
import { SyntheticOAuthProvider } from "./import-fixture.ts";
import { SharingFixture } from "./sharing-fixture.ts";

test(
  "Gemini CLI signs in, imports and streams through the native plugin after a Home restart",
  { timeout: 180_000 },
  async () => {
    const candidate = process.env.POOL_TEST_IMAGE;
    assert.ok(candidate, "Build the candidate pool image");
    const provider = new SyntheticOAuthProvider();
    let fixture: SharingFixture | undefined;
    try {
      await provider.start();
      fixture = new SharingFixture({
        image: candidate,
        resourcePrefix: "basalt-gemini",
        poolContainerArgs: provider.poolContainerArgs,
      });
      await fixture.start();
      let acquired: string | undefined;
      const home = new HomeClient((path, init) =>
        path.includes("/oauth/status") && acquired
          ? Promise.resolve(Response.json({ status: "ok", auth_id: acquired }))
          : fixture!.fetchHome(path, init),
      );
      await withProviderProduct(home, async (product) => {
        const key = await new ComputerHome(home).mint(
          "fixture-owner",
          product.pool,
          "fixture-computer",
        );
        async function plugin() {
          const result = await fixture!.data<{
            plugins: { id: string; effective_enabled: boolean; oauth_provider: string }[];
          }>("/plugins");
          assert.ok(
            result.plugins.some(
              (item) =>
                item.id === "gemini-cli" &&
                item.effective_enabled &&
                item.oauth_provider === "gemini-cli",
            ),
          );
        }
        await plugin();
        const providerApp = await product.provider("gemini");
        const pending = await product.run(
          product.request(
            "POST",
            `${product.appPath(providerApp.id)}/accounts/app/gemini/connections`,
            {},
          ),
        );
        const path = `${product.prefix}/connections/${pending.id}/interactive`;
        const started = await product.run(
          product.request("POST", `${path}/start`, { method: "geminiCli" }),
        );
        assert.equal(new URL(started.url).hostname, "accounts.google.com");
        // The synthetic provider completes OAuth globally; only the host saves and selects its account.
        acquired = crypto.randomUUID();
        const upload = await home.data("/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uuid: acquired,
            type: "gemini-cli",
            email: "fixture-gemini@example.invalid",
            access_token: "synthetic-gemini-token",
            refresh_token: "synthetic-gemini-refresh",
            project_id: "fixture-project",
            expiry: "2099-01-01T00:00:00Z",
            proxy_url: provider.url,
          }),
        });
        assert.equal(upload.name, `${acquired}.json`);
        const saved = await product.run(product.request("GET", `${path}/status`));
        assert.equal(saved.state, "connected");
        await product.select("gemini", saved.account.id);
        async function catalog() {
          const deadline = Date.now() + 20_000;
          do {
            const response = await fetch(`${fixture!.node}/v1/models`, {
              headers: { Authorization: `Bearer ${key.key}` },
            });
            const result = (await response.json()) as { data?: { id: string }[] };
            if (response.ok && result.data?.some((model) => model.id === "gemini-2.5-pro")) return;
            await delay(100);
          } while (Date.now() < deadline);
          assert.fail("Gemini credential did not reach the node's authenticated catalog");
        }
        async function stream() {
          const response = await fixture!.model(
            key.key,
            crypto.randomUUID(),
            false,
            "gemini-2.5-pro",
          );
          assert.equal(response.status, 200);
          const text = await response.text();
          assert.match(text, /OK/);
          assert.match(text, /data: \[DONE\]/);
        }
        await catalog();
        await stream();
        await fixture!.replaceImage(candidate);
        await plugin();
        await catalog();
        await stream();
        assert.ok(
          provider.requests.filter(
            (item) =>
              item.authority === "cloudcode-pa.googleapis.com" &&
              item.path.startsWith("/v1internal:streamGenerateContent"),
          ).length >= 2,
        );
        assert.deepEqual(
          await fixture!.diagnostics.scan([
            "synthetic-gemini-token",
            "synthetic-gemini-refresh",
            "Reply with the pool name",
          ]),
          { database: 0, files: 0, logs: 0 },
        );
      });
    } finally {
      try {
        await fixture?.close();
      } finally {
        await provider.close();
      }
    }
  },
);
