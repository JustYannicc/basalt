import { BarrierRefusal } from "./refusal.ts";
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
  assertNamespaceAttachment,
  decodeNamespaceBaseline,
  type NamespaceBaseline,
  type NamespaceObservation,
  runtimeNamespaceAttachment,
} from "./provisioning-namespace.ts";
import { provisioningJournal, type ProvisioningStore } from "./provisioning-journal.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";
import { setConfigurationDrift } from "./container-configuration.ts";

export interface RuntimeProvisioningProvider {
  namespaceBaseline(): Promise<NamespaceBaseline>;
  observeNamespace(): Promise<NamespaceObservation>;
  active(): Promise<RuntimeProvisioningManifest["active"]>;
  applicationAbsent(): Promise<boolean>;
  createApplication(namespaceId: string): Promise<CreatedRuntimeApplication>;
  readApplication(applicationId: string): Promise<CreatedRuntimeApplication>;
  nativeState(
    namespaceId: string,
  ): Promise<{ application: CreatedRuntimeApplication; digest: string }>;
}

/** The dedicated provisioning workflow supplies a reviewed GO; ordinary releases never construct one. */
export async function provisionRuntime(
  input: RuntimeProvisioningManifest,
  store: ProvisioningStore,
  provider: RuntimeProvisioningProvider,
  enable: ProvisioningEnable | undefined,
  now = Date.now,
): Promise<RuntimeProvisioningReceipt> {
  const manifest = structuredClone(decodeProvisioningManifest(input));
  try {
    return await provisionEnabled(manifest, input, store, provider, enable, now);
  } catch (error) {
    if (error instanceof BarrierRefusal && error.worker !== manifest.declaration.fqn)
      throw new BarrierRefusal(
        error.reason,
        manifest.declaration.fqn,
        error.delta ? { ...error.delta, fqn: manifest.declaration.fqn } : undefined,
        error.refusals,
        error.stateStore,
      );
    throw error;
  }
}

async function provisionEnabled(
  manifest: RuntimeProvisioningManifest,
  input: RuntimeProvisioningManifest,
  store: ProvisioningStore,
  provider: RuntimeProvisioningProvider,
  enable: ProvisioningEnable | undefined,
  now: () => number,
): Promise<RuntimeProvisioningReceipt> {
  assertProvisioningEnable(manifest, enable, now());
  const fingerprint = provisioningManifestDigest(manifest);
  const journal = provisioningJournal(
    store,
    manifest.candidate,
    fingerprint,
    manifest.declaration.fqn,
  );
  const active = async () => {
    assertProvisioningEnable(manifest, enable, now());
    sameProvisioningValue("manifest", fingerprint, provisioningManifestDigest(input));
    sameProvisioningValue("active.runtime", manifest.active, await provider.active());
  };
  await active();
  const baseline = await journal.observe(
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
  const attachment = runtimeNamespaceAttachment(baseline, manifest.declaration);
  sameProvisioningValue(
    "namespace.attachmentDigest",
    manifest.namespaceRequestDigest,
    digest(canonical(attachment)),
  );
  const namespace = assertNamespaceAttachment(
    attachment,
    baseline,
    await provider.observeNamespace(),
  );
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
      assertNamespaceAttachment(attachment, baseline, await provider.observeNamespace());
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
  // Create and read responses may stamp or resolve fields differently; identity and settings may not.
  sameProvisioningValue("application.readback", settingsOf(created), settingsOf(application));
  const configuration = {
    image: manifest.declaration.props.image,
    instanceType: manifest.declaration.props.instanceType,
    environmentVariables: [
      { name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: manifest.declaration.accountId },
    ],
    observability: manifest.declaration.props.observability,
  };
  assertSetConfiguration(manifest, "application.created.configuration", configuration, created);
  assertSetConfiguration(manifest, "application.configuration", configuration, application);
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
    "application.maxInstances",
    manifest.declaration.props.maxInstances,
    application.maxInstances,
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
    resource: manifest.declaration.fqn,
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

const settingsOf = (value: CreatedRuntimeApplication) => ({
  applicationId: value.applicationId,
  applicationName: value.applicationName,
  accountId: value.accountId,
  schedulingPolicy: value.schedulingPolicy,
  instances: value.instances,
  maxInstances: value.maxInstances,
  constraints: value.constraints,
  durableObjects: value.durableObjects,
});

function assertSetConfiguration(
  manifest: RuntimeProvisioningManifest,
  path: string,
  set: CreatedRuntimeApplication["configuration"],
  application: CreatedRuntimeApplication,
) {
  const changed = setConfigurationDrift(set, application.configuration).map((change) => ({
    ...change,
    path: `${path}.${change.path}`,
  }));
  if (!changed.length) return;
  const { fqn } = manifest.declaration;
  const refusal = new BarrierRefusal("provisioning-configuration-drift", fqn, {
    fqn,
    type: "Cloudflare.Container",
    changed,
    why: ["A created application must read back what its create request set."],
  });
  refusal.message += `: ${changed
    .map((change) =>
      "old" in change ? `${change.path} ${change.old} -> ${change.new}` : change.path,
    )
    .join(", ")}`;
  throw refusal;
}
