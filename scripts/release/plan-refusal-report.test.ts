import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import { checkPlan, decodePlanPolicy } from "./plan-check.ts";
import { failureReport } from "./public-report.ts";
import {
  accountId,
  applicationId,
  buildContext,
  makePlan,
  observationTokenRow,
  pinnedImage,
  productionRows,
  type PlanInput,
} from "./test/plan-fixture.ts";

// Real refusals: Alchemy's own planner and providers over production-shaped State, checked by the
// release's plan check, then reported the way the release entry prints a stop in public.

// An account id that starts with a letter, so each of its characters could pass for a name.
const recordedAccount = "abcdef0123456789".repeat(2);
const tokenValue = "synthetic-observation-token-value";

const policy = () =>
  Effect.runPromise(
    decodePlanPolicy({
      mode: "release",
      protected: {
        fqns: ["PoolContainer", "VaultAttachments", "PoolProviderObservationToken"],
        types: [],
      },
      removals: [],
      poolContainer: { fqn: "PoolContainer", image: pinnedImage },
      poolWorker: "PoolWorker",
      artifactsCredentials: "ArtifactsCredentials",
      allow: [],
    }),
  );

async function publicText(context: TestContext, input: PlanInput) {
  const { plan } = await makePlan(context, { rows: productionRows(), ...input });
  const error = await Effect.runPromise(checkPlan(plan, await policy())).then(
    () => assert.fail("the plan was admitted"),
    (failure: unknown) => failure,
  );
  const report = failureReport(error);
  // Nothing that is a value, a host, an id or a secret: only names and indexes.
  for (const value of [
    accountId,
    recordedAccount,
    applicationId,
    tokenValue,
    "synthetic-management-secret",
    "namespace-elsewhere",
    "namespace-pool-container",
    "registry.cloudflare.com",
    "pool-root",
    "basalt-production",
    "com.cloudflare",
    "cloudflare",
    "127.0.0.1",
    buildContext,
  ])
    assert.ok(!report.publicText.includes(value), `${value} in ${report.publicText}`);
  for (const shape of [
    /[a-f0-9]{16,}/iu,
    /[0-9a-f]{8}-[0-9a-f]{4}-/iu,
    /sha256/iu,
    / -> /u,
    /withheld|absent/u,
  ])
    assert.doesNotMatch(report.publicText, shape);
  return { text: report.publicText, detail: report.detail };
}

test("a refused root names the keys that differ, and the values stay in the sealed detail", async (context) => {
  const rows = productionRows();
  const root = rows.PoolContainer as unknown as { bindings: { sid: string; data: unknown }[] };
  root.bindings = [
    { sid: "PoolContainer", data: { durableObjects: { namespaceId: "namespace-elsewhere" } } },
  ];
  const { text, detail } = await publicText(context, { rows });
  assert.match(
    text,
    /pool-container-attachment-change@PoolContainer\[bindings\.PoolContainer\.durableObjects\.namespaceId\]/u,
  );
  assert.match(text, /pool-container-not-noop@PoolContainer\[\$action,/u);
  assert.match(detail, /durableObjects\.namespaceId: namespace-elsewhere -> /u);
});

test("a root declared from source or reconfigured names its props, not the image or the sizes", async (context) => {
  const built = await publicText(context, { declared: { container: { context: buildContext } } });
  assert.match(built.text, /pool-container-built-from-source@PoolContainer\[props\.context\]/u);
  assert.match(built.text, /pool-container-image-not-pinned@PoolContainer\[props\.image\]/u);
  assert.match(built.detail, /pool-root@sha256/u);
  const resized = await publicText(context, { declared: { containerInstanceType: "standard" } });
  assert.match(
    resized.text,
    /pool-container-configuration-change@PoolContainer\[props\.instanceType\]/u,
  );
  assert.doesNotMatch(resized.text, /standard|basic/u);
});

test("a record keyed by data prints as {key}: a token's resources never show its account", async (context) => {
  // The token's policy resources are keyed by `com.cloudflare.api.account.<id>`: data, with dots.
  const rows = {
    ...productionRows(),
    PoolProviderObservationToken: observationTokenRow(recordedAccount, tokenValue),
  };
  const { text, detail } = await publicText(context, {
    rows,
    declared: { observationToken: true },
  });
  assert.match(
    text,
    /protected-resource-destroyed@PoolProviderObservationToken\[\$resource,props\.accountId,props\.policies\.0\.resources\.\{key\}\]/u,
  );
  // The sealed detail still holds the full lines a reviewer needs.
  assert.ok(detail.includes(`resources.com.cloudflare.api.account.${recordedAccount}`), detail);
});
