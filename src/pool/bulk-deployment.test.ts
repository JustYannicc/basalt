import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { bulkImportEnvironment } from "./model-history/bulk-deployment.ts";

const bindings = (dev: boolean) =>
  Effect.runPromise(
    bulkImportEnvironment.pipe(
      Effect.provideService(AlchemyContext, { dev, adopt: false, dotAlchemy: ".alchemy" }),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
    ),
  );

test("local Cloud planning keeps the production-only pool bindings absent without vendor settings", async () => {
  assert.deepEqual(await bindings(true), {});
});

test("production Cloud planning still requires the real pool database configuration", async () => {
  await assert.rejects(() => bindings(false), /PLANETSCALE_DATABASE_NAME/);
});
