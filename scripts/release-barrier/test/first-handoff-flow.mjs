import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Effect, Redacted, ConfigProvider } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { handoffWorker } from "../../pool-tests/runtime-handoff-worker.ts";
import { selectionProof, runtimeFixtureCode } from "../../pool-tests/runtime-handoff-proofs.ts";
import { runtimeConfiguration } from "../../../src/pool/runtime-slots/configuration.ts";
import { freezeRuntimeHandoff, runtimeBridgeKeyDigest } from "../runtime-slot-manifest.ts";
import { runtimeApplicationConfigDigest } from "../runtime-slot-provider-proof.ts";
import { decodeApplication } from "../container-observation.ts";
import {
  decodeHandoffWorker,
  freezeFirstHandoff,
  firstHandoffDigest,
} from "../first-handoff-contract.ts";
import { firstHandoffWorkerProvider } from "../first-handoff-cloudflare.ts";
import { firstHandoffRuntime } from "../first-handoff-runtime.ts";
import { readRuntimeProvisioningHeader } from "../provisioning-header.ts";
import { runFirstHandoff } from "../first-handoff-service.ts";
import { State } from "alchemy/State/State";
import { firstHandoffWorkerHttp } from "./first-handoff-worker-http.mjs";
import { firstHandoffBridge } from "./first-handoff-bridge.mjs";

globalThis.fetch = () => {
  throw new Error("REAL NETWORK DENIED");
};
export async function firstHandoffFlow(options = {}) {
  const f = await handoffWorker({
    adopt: false,
    rotateSigningKey: true,
    bindings: {
      POOL_PROVIDER_OBSERVATION_TOKEN: { get: async () => "synthetic-provider-read" },
    },
  });
  const events = [];
  let worker = f.worker,
    saved,
    queue = Promise.resolve(),
    deploymentId = "legacy-deployment";
  const accountId = "1".repeat(32),
    scriptName = "synthetic-poolworker",
    key = f.old.env.POOL_DEPLOYMENT_KEY;
  const application = (runtime, namespaceId) => ({
    id: runtime.target.applicationId,
    name: `synthetic-${runtime.target.slotId}`,
    account_id: accountId,
    version: Number(runtime.target.applicationVersion),
    created_at: "2026-11-09T00:00:00Z",
    instances: 0,
    max_instances: 1,
    scheduling_policy: "default",
    constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
    durable_objects: { namespace_id: namespaceId },
    configuration: {
      image: `registry.cloudflare.com/${accountId}/synthetic@${runtime.target.imageDigest}`,
      instance_type: "basic",
      environment_variables: [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId }],
      observability: { logs: { enabled: true } },
    },
  });
  const legacyApplication = application(f.old, "legacy-namespace"),
    candidateApplication = application(f.candidate, "candidate-namespace");
  const common = {
    candidate: runtimeFixtureCode.candidate,
    stack: "synthetic",
    stage: "production",
    controllerCode: runtimeFixtureCode,
    controller: { accountId, scriptName },
    bridgeKey: {
      baselineDigest: runtimeBridgeKeyDigest(key),
      candidateDigest: runtimeBridgeKeyDigest(key),
    },
  };
  const initial = await selectionProof(f.old.storage);
  assert.equal(initial.expectedEpoch, 0);
  assert.equal(initial.active, null);
  const legacy = await freezeRuntimeHandoff({
    ...common,
    disposition: "preserve-unattested",
    operationId: "legacy-adopt-operation",
    target: f.old.target,
    provider: {
      accountId,
      namespaceId: "legacy-namespace",
      applicationConfigDigest: runtimeApplicationConfigDigest(decodeApplication(legacyApplication)),
    },
    configuration: runtimeConfiguration(f.old.env),
    selection: initial,
  });
  const candidate = await freezeRuntimeHandoff({
    ...common,
    disposition: "runtime-handoff",
    operationId: "candidate-start-operation",
    target: f.candidate.target,
    provider: {
      accountId,
      namespaceId: "candidate-namespace",
      applicationConfigDigest: runtimeApplicationConfigDigest(
        decodeApplication(candidateApplication),
      ),
    },
    configuration: runtimeConfiguration(f.candidate.env),
    selection: { ...initial, expectedEpoch: 1, active: f.old.identity() },
  });
  const baseline = decodeHandoffWorker({
    accountId,
    scriptName,
    deploymentId,
    version: {
      id: "legacy-version",
      createdOn: "2026-11-09T00:00:00Z",
      number: 1,
      urls: [],
      startupTimeMs: 30,
      mainModule: "legacy.mjs",
      modules: [
        {
          name: "legacy.mjs",
          contentType: "application/javascript+module",
          contentBase64: Buffer.from("export default {};\n").toString("base64"),
        },
      ],
      exports: {
        default: { type: "worker" },
        PoolContainer: {
          type: "durable-object",
          storage: "sqlite",
          container: "PoolContainer",
          state: "created",
        },
        PoolRuntime: {
          type: "durable-object",
          storage: "sqlite",
          container: "PoolRuntime",
          state: "created",
        },
      },
      containers: [{ className: "PoolContainer" }, { className: "PoolRuntime" }],
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      limits: { cpuMs: 30_000 },
      placement: { mode: "smart" },
      bindings: [
        ...Object.entries(f.old.env).map(([name, text]) => ({ name, type: "plain_text", text })),
        { name: "KEEP", type: "plain_text", text: "synthetic-retained-setting" },
        {
          name: "PoolContainer",
          type: "durable_object_namespace",
          className: "PoolContainer",
          namespaceId: "legacy-namespace",
        },
        {
          name: "PoolRuntime",
          type: "durable_object_namespace",
          className: "PoolRuntime",
          namespaceId: "candidate-namespace",
        },
      ],
    },
  });
  const manifest = freezeFirstHandoff({
    schemaVersion: 3,
    disposition: "first-handoff",
    baseline,
    mainModule: "handoff.mjs",
    modules: [
      {
        name: "handoff.mjs",
        contentType: "application/javascript+module",
        contentBase64: readFileSync(
          new URL("../../../src/pool/worker.ts", import.meta.url),
        ).toString("base64"),
      },
    ],
    legacy,
    legacyBootId: f.old.identity().bootId,
    candidate,
    promotionOperationId: "candidate-promote-operation",
    drainOperationId: "legacy-drain-operation",
  });
  const enable = {
    coordinatorGo: "synthetic-local-proof-only",
    writerLease: "synthetic-exclusive-writer",
    manifest: firstHandoffDigest(manifest),
    expiresAt: Date.now() + 60_000,
  };
  const { client, desired, fetcher } = firstHandoffWorkerHttp({
    manifest,
    f,
    options,
    events,
    applyBindings: (bindings) => {
      worker = f.advanceCurrentBindings(bindings);
    },
    applications: { legacyApplication, candidateApplication },
  });
  globalThis.fetch = fetcher;
  const target = firstHandoffBridge({
    accountId,
    scriptName,
    key,
    f,
    options,
    events,
    current: () => worker,
    replace: (value) => {
      worker = value;
    },
  });
  const run = (effect) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(State, Effect.succeed(state)),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiBaseUrl: "https://api.cloudflare.com/client/v4",
            apiToken: Redacted.make("synthetic-only"),
          }),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-only" } }),
          ),
        ),
      ),
    );
  let crashInjected = false;
  const state = {
    getOutput: () => Effect.sync(() => structuredClone(saved)),
    setOutput: ({ value }) =>
      Effect.sync(() => {
        saved = structuredClone(value);
        if (
          options.crashBeforeCodeStage &&
          !crashInjected &&
          readRuntimeProvisioningHeader(saved, key).record.operations["handoff-code-stage"]
            ?.outcome === "pending"
        ) {
          crashInjected = true;
          throw new Error("crash after intent before provider send");
        }
      }),
  };
  const exclusive = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const provider = await run(firstHandoffWorkerProvider(manifest, enable));
  const runtime = await run(
    firstHandoffRuntime({ manifest, enable, signingKey: key, target, fetcher }),
  );
  const activate = (overrides) =>
    run(
      runFirstHandoff({
        manifest,
        enable,
        recoveryKey: key,
        signingKey: key,
        lease: { id: enable.writerLease, exclusive },
        target,
        fetcher,
        ...overrides,
      }),
    );
  return {
    ...f,
    manifest,
    enable,
    activate,
    events,
    desired,
    runtime,
    provider,
    saved: () => saved,
    worker: () => worker,
    cleanup: f.cleanup,
  };
}
