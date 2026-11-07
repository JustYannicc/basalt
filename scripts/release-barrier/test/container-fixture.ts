import type { PreparedContainerPublication } from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import { Effect } from "effect";
import type { BarrierReceipt, ContainerVersionProvider, VersionProvider } from "../barrier.ts";
import { containerSnapshot, type ContainerAttributes, type FrozenContainer } from "../container.ts";
import { describeWorker, type ReleaseManifest } from "../manifest.ts";
import { describeContainer } from "../container.ts";
import type { ContainerApplication } from "alchemy/Cloudflare";

export const image = (value: string) =>
  `registry.cloudflare.com/fixture/pool@sha256:${value.repeat(64)}`;
const placement: ContainerApplication.Constraints & { jurisdiction: "eu"; regions: string[] } = {
  jurisdiction: "eu",
  regions: ["EEUR", "WEUR"],
};
export const props = {
  context: "/fixture",
  className: "PoolContainer",
  instanceType: "basic",
  maxInstances: 1,
  schedulingPolicy: "default",
  constraints: placement,
};
export const containerProps = () => structuredClone(props);
export function containerPublication() {
  const previous: ContainerAttributes = {
    accountId: "fixture",
    applicationId: "pool-app",
    applicationName: "pool",
    version: 1,
    configuration: { image: image("1"), instanceType: "basic" },
    instances: 1,
    maxInstances: 1,
    constraints: structuredClone(placement),
    affinities: undefined,
    durableObjects: { namespaceId: "namespace" },
    schedulingPolicy: "default",
    dev: undefined,
    createdAt: "2026-01-01T00:00:00Z",
    hash: { image: "a".repeat(16), digest: `sha256:${"1".repeat(64)}` },
  };
  const proposed = {
    ...structuredClone(previous),
    configuration: { ...previous.configuration, image: image("2") },
    hash: { image: "b".repeat(16), digest: `sha256:${"2".repeat(64)}` },
  };
  const rolloutRequest = {
    accountId: "fixture",
    applicationId: "pool-app",
    targetConfiguration: structuredClone(proposed.configuration),
    strategy: "rolling",
    kind: "full_manual",
    stepPercentage: 100,
    description: "Immediate update",
  };
  const publication: PreparedContainerPublication = {
    id: "PoolContainer",
    previous,
    proposed,
    rolloutRequest,
    verifySource: Effect.void,
    read: () => Effect.succeed(previous),
    rollout: () => Effect.succeed({ id: "rollout", current_version: 1, target_version: 2 }),
  };
  const metadata = {
    digest: proposed.hash.digest,
    configDigest: `sha256:${"3".repeat(64)}`,
    platform: "linux/amd64",
    capabilityLabel: "1",
  };
  const frozen: FrozenContainer = {
    id: "PoolContainer",
    baseline: containerSnapshot(previous),
    configuration: structuredClone(proposed.configuration),
    rolloutRequest,
    baselineInputHash: previous.hash!.image!,
    inputHash: proposed.hash.image,
    imageDigest: metadata.digest,
    imageConfigDigest: metadata.configDigest,
    platform: "linux/amd64",
    capabilityLabel: "1",
  };
  return { publication, previous, proposed, frozen, metadata };
}

export function containerRelease() {
  const setup = containerPublication();
  let current = structuredClone(setup.previous);
  const events: string[] = [];
  const receipts: BarrierReceipt[] = [];
  const manifest: ReleaseManifest = {
    schemaVersion: 2,
    candidate: "a".repeat(40),
    stack: "basalt",
    stage: "production",
    containers: [setup.frozen],
    workers: ["Api", "PoolWorker", "Router"].map((id) => ({
      id,
      scriptName: id,
      accountId: "fixture",
      metadata: { mainModule: "main.js" },
      files: [
        {
          name: "main.js",
          type: "application/javascript+module",
          bytes: new TextEncoder().encode("export default {}"),
        },
      ],
      baseline: [{ versionId: `old-${id}`, percentage: 100 }],
    })),
  };
  const active = new Map(manifest.workers.map((worker) => [worker.id, worker.baseline]));
  const provider: VersionProvider = {
    async upload(worker) {
      events.push(`admit:${worker.id}`);
      return { versionId: `new-${worker.id}`, startupTimeMs: 125 };
    },
    async baseline(worker) {
      return active.get(worker.id)!;
    },
    async activate(worker, versionId) {
      events.push(`activate:${worker.id}`);
      active.set(worker.id, [{ versionId, percentage: 100 }]);
    },
  };
  const containers: ContainerVersionProvider = {
    async verifySource() {
      events.push("image:verified");
    },
    async read() {
      return structuredClone(current);
    },
    async rollout() {
      events.push("container:rollout");
      current = { ...setup.proposed, version: 2 };
      return { id: "rollout", currentVersion: 1, targetVersion: 2 };
    },
    async advance() {
      events.push("container:advance");
    },
    async wait() {
      events.push("container:adopted");
      return structuredClone(current);
    },
  };
  const options = {
    provider,
    containers,
    async record(value: BarrierReceipt) {
      receipts.push(structuredClone(value));
    },
    async beforeActivate() {
      events.push("database");
    },
  };
  const description = {
    candidate: manifest.candidate,
    stack: manifest.stack,
    stage: manifest.stage,
    workers: manifest.workers.map(describeWorker),
    schemaVersion: 2 as const,
    containers: [describeContainer(setup.frozen)],
  };
  return {
    ...setup,
    manifest,
    options,
    description,
    events,
    receipts,
    active,
    current: () => structuredClone(current),
    setCurrent: (value: ContainerAttributes) => {
      current = structuredClone(value);
    },
  };
}
