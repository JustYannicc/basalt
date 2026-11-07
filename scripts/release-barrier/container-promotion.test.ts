import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { advanceContainer, observeContainerPromotion } from "./container-promotion.ts";
import { containerPublication } from "./test/container-fixture.ts";

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

for (const lostResponse of [false, true])
  test(`manual singleton promotion sends next once and reconciles a lost response: lost=${lostResponse}`, async () => {
    const target = containerPublication().frozen.baseline;
    const rollout = { id: "recorded", currentVersion: 1, targetVersion: 2 };
    let status = "pending";
    let posts = 0;
    const methods: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      assert.ok(String(input).endsWith("/applications/pool-app/rollouts/recorded"));
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)), { action: "next" });
        posts++;
        status = "completed";
        if (lostResponse) throw new Error("response lost after promotion");
      }
      return Response.json({
        success: true,
        errors: [],
        result: {
          id: "recorded",
          current_version: 1,
          target_version: 2,
          kind: "full_manual",
          status,
        },
      });
    };
    const promotion = run(advanceContainer(target, rollout, fetcher));
    if (lostResponse) {
      await assert.rejects(promotion, /container-promotion-unconfirmed/);
      await run(observeContainerPromotion(target, rollout, fetcher));
    } else await promotion;
    assert.equal(posts, 1);
    assert.deepEqual(methods, ["GET", "POST", "GET"]);
  });

test("unconfirmed advancement and a foreign target refuse without another mutation", async () => {
  const target = containerPublication().frozen.baseline;
  const rollout = { id: "recorded", currentVersion: 1, targetVersion: 2 };
  for (const version of [2, 99]) {
    let posts = 0;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") posts++;
      return Response.json({
        success: true,
        errors: [],
        result: {
          id: "recorded",
          current_version: 1,
          target_version: version,
          kind: "full_manual",
          status: "pending",
        },
      });
    };
    await assert.rejects(
      run(observeContainerPromotion(target, rollout, fetcher)),
      /container-(recovery-promotion-unconfirmed|promotion-state-drift)/,
    );
    assert.equal(posts, 0);
  }
});
