import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Cloudflare from "alchemy/Cloudflare";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import type { PreviewIdentity } from "../environment.ts";
import {
  capturePreviewProviderInventory,
  verifyPreviewProvidersAbsent,
  type PreviewProviderReadbacks,
} from "./provider-absence.ts";
import type { PreviewInventory } from "./inventory.ts";

type ContainerReadback = Pick<Cloudflare.Containers.ContainerApplication["Attributes"], "applicationId" | "applicationName">;
type WorkerReadback = Pick<Cloudflare.Workers.Worker["Attributes"], "workerName" | "domain">;

const identity: PreviewIdentity = {
  pullRequest: 17,
  stage: "test-pr-17",
  sourceNamespace: "basalt-preview-pr-17-apps",
  databaseName: "basalt-preview-pr-17",
  origin: "https://app.pr-17.preview.example.invalid",
};

function resource(
  fqn: string,
  resourceType: string,
  attr: Record<string, unknown>,
  props: Record<string, unknown> = {},
): CreatedResourceState {
  return {
    kind: "resource",
    resourceType,
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: "fixture-instance",
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props,
    attr,
  };
}

function inventory(): PreviewInventory {
  const container: ContainerReadback = {
    applicationId: "application-17",
    applicationName: "basalt-test-pr-17-pool",
  };
  const worker: WorkerReadback = {
    workerName: "basalt-router-test-pr-17",
    domain: { name: "app.pr-17.preview.example.invalid", aliases: [], redirects: [] },
  };
  return {
    version: 1,
    capturedAt: "2026-10-24T00:00:00.000Z",
    stacks: {
      basalt: [
        {
          path: "basalt/test-pr-17/PoolContainer",
          value: resource("PoolContainer", "Cloudflare.Container", { ...container }),
        },
        {
          path: "basalt/test-pr-17/Router",
          value: resource("Router", "Cloudflare.Worker", { ...worker }),
        },
        {
          path: "basalt/test-pr-17/AppBuilds",
          value: resource("AppBuilds", "Cloudflare.R2.Bucket", { bucketName: "preview-app-builds-pr-17" }),
        },
        { path: "basalt/test-pr-17/output", value: null },
      ],
      "basalt-preview-database": [],
    },
    providers: { complete: false, containers: [], domains: [] },
  };
}

function readbacks(): PreviewProviderReadbacks {
  return {
    async listWorkers() { return []; },
    async listR2Buckets() { return []; },
    async listContainerApplications() { return [{ applicationId: "application-17", applicationName: "basalt-test-pr-17-pool" }]; },
    async listWorkerDomains() { return [{ id: "domain-17", hostname: "app.pr-17.preview.example.invalid", service: "basalt-router-test-pr-17" }]; },
    async listPlanetScaleDatabases() { return []; },
    async artifactsNamespaceExists() { return false; },
  };
}

test("captures pinned Alchemy Container and Worker state attributes plus live domain IDs before deletion", async () => {
  const state = inventory();
  const physical = await capturePreviewProviderInventory(identity, state, readbacks());
  assert.deepEqual(physical, {
    complete: true,
    containers: [{ applicationId: "application-17", applicationName: "basalt-test-pr-17-pool" }],
    domains: [{ id: "domain-17", hostname: "app.pr-17.preview.example.invalid", service: "basalt-router-test-pr-17" }],
  });

  await verifyPreviewProvidersAbsent(identity, { ...state, providers: physical }, {
    ...readbacks(),
    async listContainerApplications() { return []; },
    async listWorkerDomains() { return []; },
  });
});

test("provider readbacks keep container and custom-domain leaks red", async () => {
  const state = inventory();
  const physical = await capturePreviewProviderInventory(identity, state, readbacks());
  const captured = { ...state, providers: physical };
  await assert.rejects(verifyPreviewProvidersAbsent(identity, captured, readbacks()), /ContainerApplications are still present/);
  await assert.rejects(verifyPreviewProvidersAbsent(identity, captured, {
    ...readbacks(),
    async listContainerApplications() { return []; },
  }), /Worker domain bindings are still present/);
});

test("an output row with null state is not treated as a provider resource", async () => {
  const state = inventory();
  const physical = await capturePreviewProviderInventory(identity, state, readbacks());
  await verifyPreviewProvidersAbsent(identity, { ...state, providers: physical }, {
    ...readbacks(),
    async listContainerApplications() { return []; },
    async listWorkerDomains() { return []; },
  });
});
