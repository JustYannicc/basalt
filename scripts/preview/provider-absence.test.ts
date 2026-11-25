import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Cloudflare from "alchemy/Cloudflare";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import type { PreviewIdentity } from "../environment.ts";
import {
  capturePreviewProviderInventory,
  namedForStage,
  verifyPreviewProvidersAbsent,
  type PreviewProviderReadbacks,
} from "./provider-absence.ts";
import type { PreviewInventory } from "./inventory.ts";

type ContainerReadback = Pick<
  Cloudflare.Containers.ContainerApplication["Attributes"],
  "applicationId" | "applicationName"
>;
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
          value: resource("AppBuilds", "Cloudflare.R2.Bucket", {
            bucketName: "preview-app-builds-pr-17",
          }),
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
    async listWorkers() {
      return [];
    },
    async listR2Buckets() {
      return [];
    },
    async listContainerApplications() {
      return [{ applicationId: "application-17", applicationName: "basalt-test-pr-17-pool" }];
    },
    async listWorkerDomains() {
      return [
        {
          id: "domain-17",
          hostname: "app.pr-17.preview.example.invalid",
          service: "basalt-router-test-pr-17",
        },
      ];
    },
    async listPlanetScaleDatabases() {
      return [];
    },
    async artifactsNamespaceExists() {
      return false;
    },
  };
}

test("captures pinned Alchemy Container and Worker state attributes plus live domain IDs before deletion", async () => {
  const state = inventory();
  const physical = await capturePreviewProviderInventory(identity, state, readbacks());
  assert.deepEqual(physical, {
    complete: true,
    containers: [{ applicationId: "application-17", applicationName: "basalt-test-pr-17-pool" }],
    domains: [
      {
        id: "domain-17",
        hostname: "app.pr-17.preview.example.invalid",
        service: "basalt-router-test-pr-17",
      },
    ],
  });

  await verifyPreviewProvidersAbsent(
    identity,
    { ...state, providers: physical },
    {
      ...readbacks(),
      async listContainerApplications() {
        return [];
      },
      async listWorkerDomains() {
        return [];
      },
    },
  );
});

test("provider readbacks keep container and custom-domain leaks red", async () => {
  const state = inventory();
  const physical = await capturePreviewProviderInventory(identity, state, readbacks());
  const captured = { ...state, providers: physical };
  await assert.rejects(
    verifyPreviewProvidersAbsent(identity, captured, readbacks()),
    /ContainerApplications are still present/,
  );
  await assert.rejects(
    verifyPreviewProvidersAbsent(identity, captured, {
      ...readbacks(),
      async listContainerApplications() {
        return [];
      },
    }),
    /Worker domain bindings are still present/,
  );
});

test("an output row with null state is not treated as a provider resource", async () => {
  const state = inventory();
  const physical = await capturePreviewProviderInventory(identity, state, readbacks());
  await verifyPreviewProvidersAbsent(
    identity,
    { ...state, providers: physical },
    {
      ...readbacks(),
      async listContainerApplications() {
        return [];
      },
      async listWorkerDomains() {
        return [];
      },
    },
  );
});

test("a rehearsal left with only its buckets is proven gone by the provider's reads of its own names", async () => {
  const lane: PreviewIdentity = {
    rehearsal: 1,
    stage: "test-rehearsal-1",
    sourceNamespace: "basalt-rehearsal-1-apps",
    databaseName: "basalt-rehearsal-1",
    origin: "https://app.rehearsal-1.preview.example.invalid",
  };
  const bucket = "basalt-rehearsal-appbuilds-test-rehearsal-1-abcdefghijklmnop";
  const leftover: PreviewInventory = {
    version: 1,
    capturedAt: "2026-11-25T00:00:00.000Z",
    stacks: {
      "basalt-rehearsal": [
        {
          path: "basalt-rehearsal/test-rehearsal-1/AppBuilds",
          value: resource("AppBuilds", "Cloudflare.R2.Bucket", { bucketName: bucket }),
        },
        { path: "basalt-rehearsal/test-rehearsal-1/output", value: null },
      ],
      "basalt-preview-database": [],
    },
    providers: { complete: true, containers: [], domains: [] },
  };
  const clean: PreviewProviderReadbacks = {
    ...readbacks(),
    async listContainerApplications() {
      return [];
    },
    // Another stage's bindings and buckets, which share the zone and the stack's prefix.
    async listWorkerDomains() {
      return [{ id: "d", hostname: "app.rehearsal-12.preview.example.invalid", service: "s" }];
    },
    async listR2Buckets() {
      return ["basalt-rehearsal-appbuilds-test-rehearsal-12-abcdefghijklmnop"];
    },
  };
  // Proven gone with nothing recorded to bind: no Worker, domain, bucket, database or namespace.
  await verifyPreviewProvidersAbsent(lane, leftover, clean);
  for (const [why, readback] of [
    [
      "the recorded bucket",
      {
        async listR2Buckets() {
          return [bucket];
        },
      },
    ],
    [
      "a bucket named for the stage",
      {
        async listR2Buckets() {
          return ["basalt-rehearsal-siteassets-test-rehearsal-1-zzzzzzzzzzzzzzzz"];
        },
      },
    ],
    [
      "a domain under the stage",
      {
        async listWorkerDomains() {
          return [{ id: "d", hostname: "api.rehearsal-1.preview.example.invalid", service: "s" }];
        },
      },
    ],
    [
      "a Worker of the stage",
      {
        async listWorkers() {
          return ["worker"];
        },
      },
    ],
    [
      "its database",
      {
        async listPlanetScaleDatabases() {
          return ["basalt-rehearsal-1"];
        },
      },
    ],
    [
      "its Artifacts namespace",
      {
        async artifactsNamespaceExists() {
          return true;
        },
      },
    ],
  ] as const)
    await assert.rejects(
      verifyPreviewProvidersAbsent(lane, leftover, { ...clean, ...readback }),
      /still present/,
      why,
    );
  // A PR preview, or a rehearsal that recorded a Worker, keeps the whole-stage proof.
  await assert.rejects(
    verifyPreviewProvidersAbsent({ ...identity }, leftover, clean),
    /did not identify its custom domains/,
  );
});

test("a Worker named for the stage is the stage's even without its tag, and no other stage's", () => {
  assert.equal(namedForStage("basalt-rehearsal-api-test-rehearsal-1", "test-rehearsal-1"), true);
  assert.equal(namedForStage("basalt-rehearsal-api-test-rehearsal-12", "test-rehearsal-1"), false);
  assert.equal(namedForStage("basalt-rehearsal-api-test-rehearsal-1x", "test-rehearsal-1"), false);
  assert.equal(namedForStage("basalt-router-production", "test-rehearsal-1"), false);
  assert.throws(() => namedForStage("x", "test-.*"));
});

test("a lane's name never matches another stage's bucket or Worker that begins the same way", () => {
  for (const other of ["test-rehearsal-2x", "test-rehearsal-2313", "test-rehearsal-22"]) {
    assert.equal(namedForStage(`basalt-rehearsal-api-${other}`, "test-rehearsal-2"), false, other);
    // The bucket match is the stage between hyphens, as the absence proof applies it.
    assert.equal(
      `basalt-rehearsal-siteassets-${other}-abcdefghijklmnop`.includes("-test-rehearsal-2-"),
      false,
      other,
    );
  }
  assert.equal(namedForStage("basalt-rehearsal-api-test-rehearsal-2", "test-rehearsal-2"), true);
});
