import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import {
  assertProvisioningEnable,
  decodeProvisioningManifest,
  provisioningManifestDigest,
  type ProvisioningEnable,
  type RuntimeProvisioningManifest,
  type RuntimeProvisioningReceipt,
} from "./provisioning-contract.ts";
import { decodeCreatedRuntime, type CreatedRuntimeApplication } from "./provisioning-apply.ts";
import {
  assertRuntimeNamespace,
  decodeNamespaceBaseline,
  type NamespaceBaseline,
  type NamespaceObservation,
  runtimeNamespaceRequest,
} from "./provisioning-namespace.ts";
import { provisioningJournal, type ProvisioningStore } from "./provisioning-journal.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";

const versionResult = Schema.decodeUnknownSync(
  Schema.Struct({ versionId: Schema.NonEmptyString }),
  { onExcessProperty: "error" },
);
const activationResult = Schema.decodeUnknownSync(
  Schema.Struct({ deploymentId: Schema.NonEmptyString }),
  { onExcessProperty: "error" },
);

export interface RuntimeProvisioningProvider {
  namespaceBaseline(): Promise<NamespaceBaseline>;
  stageNamespace(
    request: ReturnType<typeof runtimeNamespaceRequest>,
  ): Promise<{ versionId: string }>;
  readNamespaceVersion(versionId: string): Promise<Workers.GetBetaWorkerVersionResponse>;
  activateNamespace(versionId: string): Promise<{ deploymentId: string }>;
  observeNamespace(): Promise<NamespaceObservation>;
  active(): Promise<RuntimeProvisioningManifest["active"]>;
  applicationAbsent(): Promise<boolean>;
  createApplication(namespaceId: string): Promise<CreatedRuntimeApplication>;
  readApplication(applicationId: string): Promise<CreatedRuntimeApplication>;
  nativeState(
    namespaceId: string,
  ): Promise<{ application: CreatedRuntimeApplication; digest: string }>;
}

/** No CLI, environment variable or ordinary release path supplies enable authority. */
export async function provisionRuntime(
  input: RuntimeProvisioningManifest,
  store: ProvisioningStore,
  provider: RuntimeProvisioningProvider,
  enable: ProvisioningEnable | undefined,
  now = Date.now,
): Promise<RuntimeProvisioningReceipt> {
  const manifest = structuredClone(decodeProvisioningManifest(input));
  assertProvisioningEnable(manifest, enable, now());
  const fingerprint = provisioningManifestDigest(manifest);
  const journal = provisioningJournal(store, manifest.candidate, fingerprint);
  const active = async () => {
    assertProvisioningEnable(manifest, enable, now());
    sameProvisioningValue("manifest", fingerprint, provisioningManifestDigest(input));
    sameProvisioningValue("active.runtime", manifest.active, await provider.active());
  };
  await active();
  const baseline = await journal.once(
    "namespace-baseline",
    manifest.namespaceBaselineDigest,
    () => provider.namespaceBaseline(),
    decodeNamespaceBaseline,
  );
  sameProvisioningValue(
    "namespace.baselineDigest",
    manifest.namespaceBaselineDigest,
    digest(canonical(baseline)),
  );
  const request = runtimeNamespaceRequest(baseline, manifest.declaration, manifest.operationId);
  const requestDigest = digest(canonical(request));
  sameProvisioningValue("namespace.requestDigest", manifest.namespaceRequestDigest, requestDigest);
  const staged = await journal.once(
    "namespace-stage",
    requestDigest,
    async () => {
      await active();
      return provider.stageNamespace(request);
    },
    versionResult,
  );
  const version = await provider.readNamespaceVersion(staged.versionId);
  sameProvisioningValue("namespace.staged.id", staged.versionId, version.id);
  for (const key of [
    "mainModule",
    "modules",
    "exports",
    "containers",
    "compatibilityDate",
    "compatibilityFlags",
    "limits",
    "placement",
    "cacheOptions",
    "assets",
    "usageModel",
  ] as const)
    sameProvisioningValue(`namespace.staged.${key}`, request[key], version[key]);
  const activation = await journal.once(
    "namespace-activation",
    digest(canonical({ versionId: staged.versionId, requestDigest })),
    async () => {
      await active();
      const current = await provider.observeNamespace();
      sameProvisioningValue(
        "namespace.beforeActivation.version",
        baseline.version.id,
        current.versionId,
      );
      sameProvisioningValue(
        "namespace.beforeActivation.namespaces",
        baseline.namespaces,
        current.namespaces,
      );
      sameProvisioningValue(
        "namespace.beforeActivation.exports",
        baseline.version.exports,
        current.exports,
      );
      sameProvisioningValue(
        "namespace.beforeActivation.containers",
        baseline.containers,
        current.containers,
      );
      return provider.activateNamespace(staged.versionId);
    },
    activationResult,
  );
  const observed = await provider.observeNamespace();
  sameProvisioningValue("namespace.deploymentId", activation.deploymentId, observed.deploymentId);
  const namespace = assertRuntimeNamespace(baseline, request, staged.versionId, observed);
  const created = await journal.once(
    "application-create",
    digest(
      canonical({
        manifest: fingerprint,
        namespaceId: namespace.namespaceId,
        template: manifest.applicationTemplateDigest,
      }),
    ),
    async () => {
      await active();
      sameProvisioningValue("namespace.beforeCreate", observed, await provider.observeNamespace());
      sameProvisioningValue("application.baseline", true, await provider.applicationAbsent());
      return provider.createApplication(namespace.namespaceId);
    },
    decodeCreatedRuntime,
  );
  const native = await provider.nativeState(namespace.namespaceId);
  sameProvisioningValue("native.acknowledgedResult", created, native.application);
  if (!/^[a-f0-9]{64}$/u.test(native.digest))
    throw provisioningRefusal(
      "provisioning-native-digest-invalid",
      "native.digest",
      "sha256",
      native.digest,
    );
  const application = await provider.readApplication(created.applicationId);
  sameProvisioningValue(
    "application.readback",
    { ...created, hash: undefined, dev: undefined },
    { ...application, hash: undefined, dev: undefined },
  );
  sameProvisioningValue(
    "application.account",
    manifest.declaration.accountId,
    application.accountId,
  );
  sameProvisioningValue(
    "application.name",
    manifest.declaration.props.name,
    application.applicationName,
  );
  sameProvisioningValue(
    "application.namespace",
    namespace.namespaceId,
    application.durableObjects.namespaceId,
  );
  sameProvisioningValue(
    "application.image",
    manifest.declaration.props.image,
    application.configuration.image,
  );
  sameProvisioningValue(
    "application.configuration",
    {
      image: manifest.declaration.props.image,
      instanceType: manifest.declaration.props.instanceType,
      environmentVariables: [
        { name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: manifest.declaration.accountId },
      ],
      observability: manifest.declaration.props.observability,
    },
    application.configuration,
  );
  sameProvisioningValue(
    "application.placement",
    manifest.declaration.props.constraints,
    application.constraints,
  );
  await active();
  const receipt: RuntimeProvisioningReceipt = {
    schemaVersion: 3,
    candidate: manifest.candidate,
    manifest: fingerprint,
    resource: "PoolRuntime",
    disposition: "idle",
    namespaceId: namespace.namespaceId,
    applicationId: application.applicationId,
    applicationVersion: application.version,
    applicationObservationDigest: digest(canonical(application)),
    nativeAfterDigest: native.digest,
    activeUnchangedDigest: digest(canonical(manifest.active)),
  };
  await journal.finish(digest(canonical(receipt)));
  return receipt;
}
