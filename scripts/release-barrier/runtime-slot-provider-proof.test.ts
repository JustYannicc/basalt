import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import {
  readRuntimeProviderProof,
  runtimeApplicationConfigDigest,
} from "./runtime-slot-provider-proof.ts";
import { decodeApplication } from "./container-observation.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";
import type { Fetcher } from "../deploy-safety/http.ts";

async function reader(
  options: {
    wrongInstance?: boolean;
    changeVersion?: boolean;
    changeConfiguration?: boolean;
    sibling?: boolean;
    wrongSiblingImage?: boolean;
    rollout?: boolean;
  } = {},
) {
  const f = await runtimeProofFixture();
  if (options.sibling) f.raw.max_instances = 64;
  const manifest = {
    ...f.manifest,
    provider: {
      ...f.manifest.provider,
      applicationConfigDigest: runtimeApplicationConfigDigest(decodeApplication(f.raw)),
    },
  };
  const calls: string[] = [];
  let applicationReads = 0;
  const fetcher: Fetcher = async (input, init) => {
    assert.equal(init?.method, "GET");
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.cloudflare.com");
    calls.push(url.pathname);
    const instances = url.pathname.endsWith("/instances-v2");
    if (!instances) applicationReads++;
    const result = instances
      ? [
          {
            id: options.wrongInstance ? "wrong-instance" : f.manifest.target.instanceId,
            application_id: f.raw.id,
            status: { state: "running" },
            image: f.raw.configuration.image,
          },
        ]
      : {
          ...f.raw,
          version: options.changeVersion && applicationReads > 1 ? 2 : 1,
          configuration: options.changeConfiguration
            ? { ...f.raw.configuration, environment_variables: [] }
            : f.raw.configuration,
        };
    if (instances && Array.isArray(result) && options.sibling)
      result.push({
        id: "4".repeat(64),
        application_id: f.raw.id,
        status: { state: "running" },
        image: options.wrongSiblingImage
          ? f.raw.configuration.image.replace(/a{64}$/, "b".repeat(64))
          : f.raw.configuration.image,
      });
    if (!instances && options.rollout)
      Object.assign(result, { active_rollout_id: "active-rollout" });
    return Response.json({
      success: true,
      errors: [],
      result,
      result_info: { next_page_token: "" },
    });
  };
  const run = (kind: "application" | "runtime") =>
    Effect.runPromise(
      readRuntimeProviderProof(manifest, kind, fetcher, () => f.now).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-provider-token" } }),
          ),
        ),
      ),
    );
  return { ...f, run, calls };
}

test("provider proof reads actual application settings and exact running instance without writes", async () => {
  const h = await reader();
  const app = await h.run("application");
  assert.equal("instanceId" in app, false);
  const runtime = await h.run("runtime");
  assert.equal(
    "instanceId" in runtime ? runtime.instanceId : undefined,
    h.manifest.target.instanceId,
  );
  assert.equal(runtime.applicationConfigDigest, h.manifest.provider.applicationConfigDigest);
  assert.notEqual(app.observationDigest, runtime.observationDigest);
  assert.equal(h.calls.filter((path) => path.endsWith("/instances-v2")).length, 1);
});

test("named runtime proof permits several verified instances in the same application", async () => {
  const h = await reader({ sibling: true });
  const proof = await h.run("runtime");
  assert.equal("instanceId" in proof ? proof.instanceId : undefined, h.manifest.target.instanceId);
});

test("siblings never substitute for the target or hide a wrong image or active rollout", async () => {
  for (const options of [
    { sibling: true, wrongInstance: true },
    { sibling: true, wrongSiblingImage: true },
    { sibling: true, rollout: true },
  ])
    await assert.rejects((await reader(options)).run("runtime"));
});

test("different runtime instance, changing app version and startup app settings refuse provider proof", async () => {
  for (const options of [
    { wrongInstance: true },
    { changeVersion: true },
    { changeConfiguration: true },
  ])
    await assert.rejects((await reader(options)).run("runtime"), /provisioning-input-drift/);
});
