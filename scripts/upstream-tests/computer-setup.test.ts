import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Schema } from "effect";
import { ProductBrand, productBrandConfig } from "../../.upstream/packages/utils/src/product-brand.ts";
import { productBrandBindings } from "../../.upstream/apps/hosted/cloud/src/infrastructure/product-brand.ts";

const configured = <A, E>(effect: Effect.Effect<A, E>, settings: Record<string, string>) =>
  Effect.runPromise(effect.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(settings)),
  ));

test("computer setup is opt-in and survives the server-to-browser brand contract", async () => {
  const unchanged = await configured(productBrandConfig, {});
  assert.deepEqual(unchanged, { name: "Executor", logo: "/favicon.png" });
  assert.deepEqual(await configured(productBrandBindings, {}), {});
  const settings = { EXECUTOR_PRODUCT_NAME: "Signalbox", EXECUTOR_COMPUTER_SETUP_URL: "/setup" };
  const brand = await configured(productBrandConfig, settings);
  assert.equal(brand.computerSetup, "/setup");
  assert.deepEqual(Schema.decodeUnknownSync(ProductBrand)(JSON.parse(JSON.stringify(brand))), brand);
  assert.deepEqual(await configured(productBrandBindings, settings), settings);
  assert.equal((await configured(productBrandConfig, { EXECUTOR_COMPUTER_SETUP_URL: " " })).computerSetup, undefined);
});

test("computer setup configuration refuses executable and protocol-relative links", async () => {
  for (const url of ["javascript:alert(1)", "//elsewhere.example/setup", "data:text/html,setup"]) {
    await assert.rejects(configured(productBrandConfig, { EXECUTOR_COMPUTER_SETUP_URL: url }));
  }
});
