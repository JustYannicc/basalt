import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, candidate } from "./fixture.ts";
import { makePlan, digest, bytesDigest, assertUnchanged, UpgradeRefusal } from "./plan.ts";
import { operate } from "./operation.ts";

test("the plan pins the exact version metadata sent without GET-only script fields", async () => {
  const f = fixture();
  f.initial.settings.annotations = { "workers/triggered_by": "upload" };
  f.state.settings.annotations = { "workers/triggered_by": "upload" };
  f.initial.runtimeSettings.limits = { cpu_ms: 30000 };
  f.state.runtimeSettings = structuredClone(f.initial.runtimeSettings);
  const plan = makePlan(f.initial, candidate);
  f.expected.planSha256 = digest(plan);
  await operate({
    mode: "apply",
    expected: f.expected,
    candidate,
    api: f.api,
    save: async () => {},
  });
  const metadata = f.requests.find((r) => r.method === "POST")!.body as Record<string, unknown>;
  assert.deepEqual(metadata, plan.upload.metadata);
  assert.equal(
    bytesDigest(new TextEncoder().encode(JSON.stringify(metadata))),
    plan.upload.metadataSha256,
  );
  for (const field of [
    "placement",
    "limits",
    "observability",
    "logpush",
    "tail_consumers",
    "tags",
    "annotations",
  ])
    assert.ok(!(field in metadata));
  assert.deepEqual(f.state.runtimeSettings.limits, { cpu_ms: 30000 });
});

test("only the provider-managed trigger annotation can change without refusing", () => {
  const f = fixture();
  f.initial.settings.annotations = { "workers/triggered_by": "upload", "workers/tag": "stable" };
  f.state.settings.annotations = { "workers/triggered_by": "deployment", "workers/tag": "stable" };
  assertUnchanged(f.initial, f.state, 7);
  assert.equal(digest(makePlan(f.initial, candidate)), digest(makePlan(f.state, candidate)));
  assert.deepEqual(makePlan(f.initial, candidate).upload.metadata.annotations, {
    "workers/tag": "stable",
  });
  f.state.settings.annotations = { "workers/tag": "changed" };
  assert.throws(() => assertUnchanged(f.initial, f.state, 7), UpgradeRefusal);
});

test("an outbound metadata change invalidates an earlier approval before any POST", async () => {
  const f = fixture();
  f.state.settings.cache_options = { enabled: true };
  await assert.rejects(
    operate({ mode: "apply", expected: f.expected, candidate, api: f.api, save: async () => {} }),
    /plan-sha256/,
  );
  assert.ok(f.requests.every((request) => request.method === "GET"));
});

for (const field of ["placement", "observability", "limits"]) {
  test(`omitting ${field} from upload still refuses drift before activation`, async () => {
    const f = fixture();
    f.hooks.uploaded = () => {
      f.state.settings[field] = { changed: true };
    };
    await assert.rejects(
      operate({ mode: "apply", expected: f.expected, candidate, api: f.api, save: async () => {} }),
      UpgradeRefusal,
    );
    assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
    assert.equal(f.state.deploymentId, "old-deployment");
  });
}
