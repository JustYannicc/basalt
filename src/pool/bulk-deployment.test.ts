import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

// A separate runtime deliberately has no resource providers: local planning must never need them.
const results = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { ConfigProvider, Effect, Exit, Cause } from "effect";
        import { AlchemyContext } from "alchemy/AlchemyContext";
        import { bulkImportEnvironment } from "./src/pool/model-history/bulk-deployment.ts";
        const run = async (dev) => {
          const result = await Effect.runPromiseExit(bulkImportEnvironment.pipe(
            Effect.provideService(AlchemyContext, { dev, adopt: false, dotAlchemy: ".alchemy" }),
            Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
          ));
          if (Exit.isSuccess(result)) return { ok: true, bindings: result.value };
          const error = Cause.squash(result.cause);
          return {
            ok: false,
            tag: error?._tag,
            requiresDatabaseName: String(error).includes("PLANETSCALE_DATABASE_NAME"),
          };
        };
        process.stdout.write(JSON.stringify({ local: await run(true), production: await run(false) }));
      `,
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  ),
);

test("local Cloud planning keeps production-only pool bindings absent without vendor settings", () => {
  assert.deepEqual(results.local, { ok: true, bindings: {} });
});

test("production Cloud planning still requires the real pool database configuration", () => {
  assert.deepEqual(results.production, {
    ok: false,
    tag: "ConfigError",
    requiresDatabaseName: true,
  });
});
