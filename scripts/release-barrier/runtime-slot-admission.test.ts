import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { openEnvelope } from "../../src/pool/token.ts";
import { runtimeAttestationFormat } from "../../src/pool/runtime-slots/admission-proof.ts";
import {
  runtimeHandoffCommandPrefix,
  decodeRuntimeHandoffCommand,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { attestRuntimeRelease, authorizeRuntimeStart } from "./runtime-slot-admission.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import type { Fetcher } from "../deploy-safety/http.ts";

async function harness(legacy = false) {
  const f = await runtimeProofFixture();
  const counts = { providerReads: 0, privateReads: 0, closed: 0 };
  const target: PoolOperationsTarget = {
    accountId: f.manifest.controller.accountId,
    worker: f.manifest.controller.scriptName,
    connect: async () => ({
      env: {
        POOL_OPERATIONS: {
          fetch: async (request) => {
            const body = (await request.json()) as { envelope: string };
            const command = decodeRuntimeHandoffCommand(
              await openEnvelope(f.signingKey, runtimeHandoffCommandPrefix, body.envelope),
              f.now,
            );
            assert.equal(command.action, "witness");
            counts.privateReads++;
            return Response.json({
              result: legacy
                ? {
                    kind: "unattested-active",
                    identity: { ...f.manifest.target, bootId: "legacy-unattested" },
                  }
                : {
                    kind: "witness",
                    controllerCode: f.manifest.controllerCode,
                    witness: f.witness,
                  },
            });
          },
        },
      },
      dispose: async () => {
        counts.closed++;
      },
    }),
  };
  const fetcher: Fetcher = async (input, init) => {
    assert.equal(init?.method, "GET");
    counts.providerReads++;
    const instances = new URL(String(input)).pathname.endsWith("/instances-v2");
    return Response.json({
      success: true,
      errors: [],
      result: instances
        ? [
            {
              id: f.manifest.target.instanceId,
              application_id: f.raw.id,
              status: { state: "running" },
              image: f.raw.configuration.image,
            },
          ]
        : f.raw,
      result_info: { next_page_token: "" },
    });
  };
  const input = {
    manifest: f.manifest,
    enable: f.enable,
    signingKey: f.signingKey,
    target,
    fetcher,
    now: () => f.now,
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-token" } }),
          ),
        ),
      ),
    );
  return { ...f, counts, input, run };
}

test("the release service joins the private retained witness to actual provider GET observations", async () => {
  const h = await harness();
  const result = await h.run(attestRuntimeRelease(h.input));
  assert.equal(result.proof.kind, "attested");
  assert.deepEqual(
    await openEnvelope(h.signingKey, runtimeAttestationFormat, result.envelope),
    result.proof,
  );
  assert.equal(h.counts.privateReads, 1);
  assert.equal(h.counts.closed, 1);
  assert.ok(h.counts.providerReads > 0);
  for (const secret of [
    h.manifest.configuration.databaseUrl,
    h.manifest.configuration.managementKey,
    h.manifest.configuration.signingKey,
  ])
    assert.equal(JSON.stringify(result).includes(secret), false);
});

test("legacy identity cannot replace the trusted startup witness even when provider image proof could pass", async () => {
  const h = await harness(true);
  await assert.rejects(h.run(attestRuntimeRelease(h.input)), /runtime-startup-witness-unverified/);
  assert.equal(h.counts.providerReads, 0);
  assert.equal(h.counts.closed, 1);
});

test("start authorization reads the provider app and causes no private runtime mutation", async () => {
  const h = await harness();
  const result = await h.run(authorizeRuntimeStart(h.input));
  assert.equal(result.proof.kind, "start");
  assert.equal("instanceId" in result.proof.provider, false);
  assert.equal(h.counts.privateReads, 0);
  assert.equal(h.counts.providerReads, 1);
});
