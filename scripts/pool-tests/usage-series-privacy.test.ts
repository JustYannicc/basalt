import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { reference } from "../../src/pool/model-history/record.ts";
import { seriesAuthority } from "../../src/pool/model-history/series-input.ts";
import { homeAccountMappingProven } from "../../src/pool/model-history/series-mapping.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { accountAuthority, full, input, seriesFixture } from "./series-fixture.ts";

for (const [gate, enabled] of [
  ["configured", homeAccountMappingProven],
  ["enabled", true],
] as const) {
  for (const state of ["rotated", "removed", "absent"] as const) {
    test(`${gate} mapping gate keeps native history counts-only with ${state} bindings`, async () => {
      await seriesFixture(async ({ db, insert }) => {
        const native = await accountAuthority();
        const account = await reference(native.source, "account", `${state}-private-credential`);
        const person = await digest("private-person-sentinel");
        const access = seriesAuthority(
          {
            canManage: true,
            mappingProven: !enabled,
            accounts: [
              ...native.authority.accounts,
              ...(state === "removed"
                ? []
                : [
                    {
                      account: "saved-stale",
                      history:
                        state === "rotated" ? [await digest("rotated-current-credential")] : [],
                    },
                  ]),
            ],
          },
          enabled,
        );
        assert.equal(access.mappingProven, enabled);
        await insert(
          {
            source: native.source,
            account,
            provider: "private-provider-sentinel",
            model: "private-model-sentinel",
            appId: "private-app-sentinel",
            person,
            attribution: "key-at-capture",
            inputTokens: "12345",
            cost: "999.000000000000",
            currency: "private-unit",
            costBasis: "home-charge",
          },
          { source: native.source, account: native.visible, inputTokens: "7" },
        );
        const result = await poolUsageSeries(
          db,
          {
            ...input,
            by: ["account", "person", "provider", "model", "app", "source", "attribution"],
          },
          access,
        );
        const unmapped = result.groups.find((group) => group.key.account === "unmapped")!;
        assert.deepEqual(unmapped.key, {
          currency: null,
          account: "unmapped",
          person: null,
          provider: null,
          model: null,
          app: null,
          source: null,
          attribution: null,
        });
        assert.deepEqual(unmapped.buckets, [
          {
            at: "2026-01-01T00:00:00.000000000Z",
            partial: false,
            requests: enabled ? 1 : 2,
            failed: 0,
            unassignedFailures: 0,
            successRate: 1,
          },
        ]);
        assert.equal(result.coverage.pricing.missing, enabled ? 1 : 2);
        for (const sentinel of [
          "private-provider-sentinel",
          "private-model-sentinel",
          "private-app-sentinel",
          "private-unit",
          "999.000000000000",
          "12345",
          person,
          account!,
        ])
          assert.equal(JSON.stringify(result).includes(sentinel), false, sentinel);
        if (enabled) {
          const visible = result.groups.find((group) => group.key.account === "saved-visible")!;
          assert.equal(full(visible.buckets[0]).tokens.input.sum, "7");
          assert.ok(full(visible.buckets[0]).lastSuccessAtInRange);
        }
      });
    });
  }
}
