/**
 * The fleet bootstrap as runtime-image-release.ts drives it: the frozen manifest saved in the image
 * record first, then the real provisionRuntime journaling in the shared State under the forward
 * journal's key, against the production-shaped PoolWorker and the world's container applications.
 * A test can stop one color's bootstrap in each state production can be left in.
 */
import { Effect } from "effect";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { canonical, digest } from "../manifest.ts";
import { runtimeNamespaceReader } from "../runtime-namespace-read.ts";
import { runtimeNamespaceAttachment, type NamespaceAttachment } from "../provisioning-namespace.ts";
import { decodeRuntimeCreate } from "../runtime-create-schema.ts";
import {
  decodeProvisioningManifest,
  provisioningManifestDigest,
} from "../provisioning-contract.ts";
import { applicationTemplateDigest, expectedApplicationRequest } from "../provisioning-wire.ts";
import { provisionRuntime, type RuntimeProvisioningProvider } from "../runtime-provisioning.ts";
import { stateProvisioningStore } from "../provisioning-state.ts";
import { decodeCreatedRuntime, type CreatedRuntimeApplication } from "../provisioning-apply.ts";
import type { RuntimeReleaseRecord } from "../runtime-release-journal.ts";
import { fleetClassName } from "../../../src/pool/fleet-deployment.ts";
import type { RuntimeColor } from "../../../src/pool/image-release-plan.ts";
import type { productionPoolWorker } from "./production-pool-worker.ts";
import { provisioningFixture, runtimeDeclaration } from "./provisioning-fixtures.ts";
import { accountId, workerName, world } from "./runtime-release-world.ts";

/** Where a color's bootstrap stops on its first attempt. */
export type BootstrapStop =
  /** The create is acknowledged; the read-back refuses once. */
  | "readback"
  /** Cloudflare created the application and alchemy recorded it; the reply is lost. */
  | "create-reply-lost"
  /** An earlier release left its namespace read pending, with no provider write. */
  | "namespace-baseline-pending";

let production: ReturnType<typeof productionPoolWorker> | undefined;
let stop: { color: RuntimeColor; at: BootstrapStop } | undefined;
const committed: Partial<Record<RuntimeColor, CreatedRuntimeApplication>> = {};
/** The production-shaped PoolWorker the release's class path and bootstraps both talk to. */
export const installProductionWorker = (value: ReturnType<typeof productionPoolWorker>) => {
  production = value;
};
/** What each finished bootstrap attached to, its creates, and the Worker writes made meanwhile. */
export const bootstrapAttachments: NamespaceAttachment[] = [];
export const bootstrapCalls = { writes: 0, creates: { blue: 0, green: 0 } };
export const resetBootstrap = (next?: { color: RuntimeColor; at: BootstrapStop }) => {
  bootstrapAttachments.length = 0;
  bootstrapCalls.writes = 0;
  bootstrapCalls.creates = { blue: 0, green: 0 };
  delete committed.blue;
  delete committed.green;
  stop = next;
};
const stopsAt = (color: RuntimeColor, at: BootstrapStop) => {
  if (stop?.color !== color || stop.at !== at) return false;
  stop = undefined;
  return true;
};

/** Cloudflare's resolved read of a new basic application, as the provider decodes it. */
const createdApplication = (
  id: string,
  props: ReturnType<typeof runtimeDeclaration>["props"],
  namespaceId: string,
) =>
  decodeCreatedRuntime({
    applicationId: id,
    applicationName: props.name,
    accountId,
    version: 1,
    createdAt: "2026-11-18T19:40:00Z",
    instances: 0,
    maxInstances: props.maxInstances,
    schedulingPolicy: "default",
    constraints: { regions: ["EEUR", "WEUR"], jurisdiction: "eu" },
    configuration: {
      image: props.image,
      vcpu: 0.25,
      memory: "1GiB",
      memoryMib: 1024,
      disk: { size_mb: 4000, size: "4GB" },
      environmentVariables: [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId }],
      network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
      command: [],
      entrypoint: [],
      runtime: "firecracker",
      observability: props.observability,
    },
    durableObjects: { namespaceId },
  });

export const bootstrapReleaseApplication = (
  stack: CompiledStack,
  options: {
    color: RuntimeColor;
    record: RuntimeReleaseRecord;
    encryptionKey: string;
    save(record: RuntimeReleaseRecord): Promise<void>;
  },
) =>
  Effect.gen(function* () {
    const { color, record } = options;
    const w = world();
    const worker = production!;
    const writes = worker.log.writes;
    const name = fleetClassName(color);
    const reader = yield* runtimeNamespaceReader(accountId, workerName).pipe(
      Effect.provide(worker.layer),
    );
    let manifest = record.bootstrap[color];
    if (!manifest) {
      const baseline = yield* Effect.promise(() => reader.baseline());
      const fixture = runtimeDeclaration(name);
      const declaration = decodeRuntimeCreate({
        ...fixture,
        accountId,
        instanceId: digest(`${record.candidate}:${name}`).slice(0, 32),
        props: { ...fixture.props, image: w.root.image.ref },
      });
      const frozen = decodeProvisioningManifest({
        schemaVersion: 3,
        disposition: "provision-only",
        candidate: record.candidate,
        stack: stack.name,
        stage: stack.stage,
        operationId: `bootstrap-${color}-${record.candidate}`,
        declaration,
        namespaceBaselineDigest: digest(canonical(baseline)),
        namespaceRequestDigest: digest(
          canonical(runtimeNamespaceAttachment(baseline, declaration)),
        ),
        applicationTemplateDigest: digest(canonical(declaration.props)),
        active: provisioningFixture(name).manifest.active,
      });
      manifest = {
        ...frozen,
        applicationTemplateDigest: applicationTemplateDigest(
          expectedApplicationRequest(frozen, "$namespace-receipt"),
          "$namespace-receipt",
        ),
      };
      yield* Effect.promise(() =>
        options.save({ ...record, bootstrap: { ...record.bootstrap, [color]: manifest! } }),
      );
    }
    const frozen = manifest;
    const props = frozen.declaration.props;
    const store = stateProvisioningStore(
      yield* yield* State,
      stack,
      options.encryptionKey,
      (work) => work(),
    );
    if (stopsAt(color, "namespace-baseline-pending")) {
      yield* Effect.promise(() =>
        store.write({
          schemaVersion: 2,
          candidate: frozen.candidate,
          manifest: provisioningManifestDigest(frozen),
          resource: name,
          complete: false,
          operations: {
            "namespace-baseline": { request: frozen.namespaceBaselineDigest, outcome: "pending" },
          },
        }),
      );
      return yield* Effect.die(new Error("string or blob too big: SQLITE_TOOBIG"));
    }
    const provider: RuntimeProvisioningProvider = {
      active: async () => frozen.active,
      namespaceBaseline: reader.baseline,
      observeNamespace: reader.observe,
      applicationAbsent: async () => committed[color] === undefined,
      createApplication: async (namespaceId) => {
        bootstrapCalls.creates[color]++;
        const app = w.createApplication(color, w.root.image, w.root.input);
        committed[color] = createdApplication(app.id, props, namespaceId);
        if (stopsAt(color, "create-reply-lost")) throw new Error("The create's reply was lost");
        return committed[color];
      },
      readApplication: async () => {
        const application = committed[color]!;
        if (!stopsAt(color, "readback")) return application;
        const { observability: _dropped, ...configuration } = application.configuration;
        return { ...application, configuration };
      },
      nativeState: async () => ({ application: committed[color]!, digest: "1".repeat(64) }),
      createdApplication: async () => committed[color],
    };
    const enable = {
      coordinatorGo: "synthetic-test-only",
      writerLease: "synthetic-exclusive-writer",
      manifest: provisioningManifestDigest(frozen),
      expiresAt: 1000,
    };
    yield* Effect.promise(() => provisionRuntime(frozen, store, provider, enable, () => 100));
    bootstrapCalls.writes += worker.log.writes - writes;
    bootstrapAttachments.push(
      runtimeNamespaceAttachment(
        yield* Effect.promise(() => reader.baseline()),
        frozen.declaration,
      ),
    );
  });
