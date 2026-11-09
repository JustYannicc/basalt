import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { readClassSettings } from "./class-settings.ts";
const target = { accountId: "synthetic-account", scriptName: "synthetic-worker" };
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-never-sent" } }),
        ),
      ),
    ),
  );

test("raw settings retain wire annotations and reject unknown properties before deployment", async () => {
  const settings = {
    compatibility_date: "2026-09-08",
    compatibility_flags: [],
    tags: ["alchemy:migration-tag:1"],
    bindings: [{ type: "plain_text", name: "SECRET_SETTING", text: "synthetic-private-value" }],
    annotations: { "workers/message": "original" },
  };
  const value = await run(
    readClassSettings(target, async () =>
      Response.json({ success: true, errors: [], result: settings }),
    ),
  );
  assert.equal(value.annotations?.workersMessage, "original");
  assert.equal(value.bindings?.[0]?.type, "plain_text");
  for (const extra of [
    { unknown_live_setting: true },
    { observability: { enabled: true, unknown_nested_setting: true } },
  ])
    await assert.rejects(
      run(
        readClassSettings(target, async () =>
          Response.json({ success: true, errors: [], result: { ...settings, ...extra } }),
        ),
      ),
      /settings-unsupported/,
    );
});

test("settings normalization preserves opaque JSON binding and JWK property keys exactly", async () => {
  const json = { my_key: 1, deep_value: { Other_Key: 2 } };
  const keyJwk = { kty: "EC", key_ops: ["sign"], custom_key: "synthetic" };
  const algorithm = { name: "ECDSA", custom_parameter: "synthetic" };
  const value = await run(
    readClassSettings(target, async () =>
      Response.json({
        success: true,
        errors: [],
        result: {
          bindings: [
            { type: "json", name: "CONFIG", json },
            {
              type: "secret_key",
              name: "SIGNER",
              format: "jwk",
              key_jwk: keyJwk,
              algorithm,
              usages: ["sign"],
            },
          ],
        },
      }),
    ),
  );
  assert.deepEqual(value.bindings?.[0], { type: "json", name: "CONFIG", json });
  assert.deepEqual(value.bindings?.[1], {
    type: "secret_key",
    name: "SIGNER",
    format: "jwk",
    keyJwk,
    algorithm,
    usages: ["sign"],
  });
});

test("unsupported settings retain safe property paths without provider data", async () => {
  const { BarrierRefusal } = await import("./manifest.ts");
  await assert.rejects(
    run(
      readClassSettings(target, async () =>
        Response.json({
          success: true,
          errors: [],
          result: {
            observability: { enabled: true, unknown_nested_setting: "private-body" },
            unknown_live_setting: "private-body",
          },
        }),
      ),
    ),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.ok(error.delta?.changed.some((item) => item.path.includes("unknownLiveSetting")));
      assert.ok(error.delta?.changed.some((item) => item.path.includes("unknownNestedSetting")));
      assert.ok(!JSON.stringify(error.delta).includes("private-body"));
      return true;
    },
  );
});
