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

const policy = (changes: Record<string, unknown> = {}) =>
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
      ...changes,
    }),
  );

async function publicText(
  context: TestContext,
  input: PlanInput,
  changes: Record<string, unknown> = {},
) {
  const { plan } = await makePlan(context, { rows: productionRows(), ...input });
  const error = await Effect.runPromise(checkPlan(plan, await policy(changes))).then(
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
    /protected-resource-destroyed@PoolProviderObservationToken\[\$resource,props\.accountId,props\.policies\[0\]\.resources\.\{key\}\]/u,
  );
  // The sealed detail still holds the full lines a reviewer needs, each key whole.
  assert.ok(
    detail.includes(String.raw`resources[\"com.cloudflare.api.account.${recordedAccount}\"]`),
    detail,
  );
});

test("a Worker's env value keyed by host prints as {key}: no piece of a host or an address shows", async (context) => {
  // A JSON env value is a record keyed by whatever the stack puts in it: here a host, and an
  // address inside it. Its pieces look like names once a key's own dots split it.
  const rows = productionRows();
  const worker = rows.ArtifactsCredentials as unknown as {
    props: { env: Record<string, unknown> };
  };
  worker.props.env.ORIGIN_REGION = { "api.example.org": { "ops@example.org": "eu" } };
  const { text, detail } = await publicText(
    context,
    { rows },
    {
      mode: "code-only",
      poolContainer: { fqn: "PoolContainer", image: pinnedImage, imageRelease: true },
      allow: [
        {
          fqn: "ArtifactsCredentials",
          action: "update",
          codeOnly: { references: [], values: [], why: "skew" },
        },
      ],
    },
  );
  assert.match(
    text,
    /code-only-allowance-exceeded@ArtifactsCredentials\[props\.env\.ORIGIN_REGION\.\{key\}\]/u,
  );
  for (const piece of ["api", "example", "org", "ops"])
    assert.doesNotMatch(text, new RegExp(String.raw`\b${piece}\b`, "u"));
  assert.ok(
    detail.includes(String.raw`ORIGIN_REGION[\"api.example.org\"][\"ops@example.org\"]`),
    detail,
  );
});
