import { object, string, type Cloudflare } from "./cloudflare.ts";
import {
  assertBaseline,
  assertExpected,
  assertUnchanged,
  bindingDigest,
  digest,
  makePlan,
  targetVersion,
  uploadMetadata,
  UpgradeRefusal,
  workerId,
  type Candidate,
  type Expected,
  type Plan,
} from "./plan.ts";

export interface Receipt {
  schemaVersion: 1;
  mode: "dry-run" | "apply";
  phase: string;
  startedAt: string;
  plan?: Plan;
  planSha256?: string;
  uploadedVersionId?: string;
  deploymentId?: string;
  verifiedVersion?: number;
  error?: {
    resource: string;
    property: string;
    expected: string | number;
    observed: string | number;
  };
}
export async function operate(options: {
  mode: "dry-run" | "apply";
  expected: Expected;
  candidate: Candidate;
  api: Cloudflare;
  save: (receipt: Receipt) => Promise<void>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const receipt: Receipt = {
    schemaVersion: 1,
    mode: options.mode,
    phase: "inventory",
    startedAt: new Date(now()).toISOString(),
  };
  const persist = async (phase: string) => {
    receipt.phase = phase;
    await options.save(structuredClone(receipt));
  };
  await persist("inventory");
  try {
    const before = await options.api.observe();
    const plan = makePlan(before, options.candidate);
    receipt.plan = plan;
    receipt.planSha256 = digest(plan);
    await persist("planned");
    if (options.mode === "dry-run") return receipt;
    assertExpected(before, plan, options.expected);
    const checked = await options.api.observe();
    assertUnchanged(before, checked, 7);
    const checkedPlan = makePlan(checked, options.candidate);
    if (digest(checkedPlan) !== receipt.planSha256)
      throw new UpgradeRefusal(
        workerId,
        "plan-before-upload-sha256",
        receipt.planSha256,
        digest(checkedPlan),
      );

    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(uploadMetadata(before, options.candidate))], {
        type: "application/json",
      }),
    );
    for (const file of options.candidate.files)
      form.append(
        file.name,
        new Blob([new Uint8Array(file.bytes)], { type: file.type }),
        file.name,
      );
    // An intent is durable before either non-idempotent request. Never replay an uncertain write.
    await persist("upload-intent");
    const uploaded = object(await options.api.upload(form));
    receipt.uploadedVersionId = string(uploaded.id, "uploaded-version-id");
    await persist("uploaded");
    if (
      typeof uploaded.startup_time_ms !== "number" ||
      !Number.isFinite(uploaded.startup_time_ms) ||
      uploaded.startup_time_ms < 0 ||
      uploaded.startup_time_ms > 750
    )
      throw new UpgradeRefusal(
        workerId,
        "startup-time-ms",
        "0 through 750",
        typeof uploaded.startup_time_ms === "number" ? uploaded.startup_time_ms : "missing",
      );
    const uploadedVersion = await options.api.version(receipt.uploadedVersionId);
    if (bindingDigest(uploadedVersion.bindings) !== plan.bindingsSha256)
      throw new UpgradeRefusal(
        workerId,
        "uploaded-bindings-sha256",
        plan.bindingsSha256,
        bindingDigest(uploadedVersion.bindings),
      );
    if (digest(uploadedVersion.runtimeSettings) !== plan.runtimeSettingsSha256)
      throw new UpgradeRefusal(
        workerId,
        "uploaded-runtime-settings-sha256",
        plan.runtimeSettingsSha256,
        digest(uploadedVersion.runtimeSettings),
      );
    const prepared = await options.api.observe();
    assertUnchanged(before, prepared, 7);
    if (prepared.deploymentId !== before.deploymentId || prepared.versionId !== before.versionId)
      throw new UpgradeRefusal(
        workerId,
        "deployment-before-activation",
        before.deploymentId,
        prepared.deploymentId,
      );
    if (prepared.latestVersionId !== receipt.uploadedVersionId)
      throw new UpgradeRefusal(
        workerId,
        "latest-upload-before-activation",
        receipt.uploadedVersionId,
        prepared.latestVersionId,
      );
    assertBaseline({ ...prepared, latestVersionId: prepared.versionId });
    await persist("activation-intent");
    const activated = object(await options.api.activate(receipt.uploadedVersionId));
    receipt.deploymentId = string(activated.id, "activated-deployment-id");
    await persist("activated");

    const deadline = now() + 60_000;
    while (true) {
      const version = await options.api.protocol();
      if (version === targetVersion) break;
      if (version !== 7 || now() >= deadline)
        throw new UpgradeRefusal(
          workerId,
          "state-store-version-after-activation",
          targetVersion,
          version,
        );
      await (
        options.delay ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
      )(1_000);
    }
    const after = await options.api.observe();
    assertUnchanged(before, after, targetVersion);
    assertBaseline(after, targetVersion);
    if (
      after.versionId !== receipt.uploadedVersionId ||
      after.deploymentId !== receipt.deploymentId
    )
      throw new UpgradeRefusal(
        workerId,
        "serving-version-after-activation",
        receipt.uploadedVersionId,
        after.versionId,
      );
    receipt.verifiedVersion = after.protocol;
    await persist("verified");
    return receipt;
  } catch (error) {
    receipt.error =
      error instanceof UpgradeRefusal
        ? {
            resource: error.resource,
            property: error.property,
            expected: error.expected,
            observed: error.observed,
          }
        : {
            resource: workerId,
            property: "operation",
            expected: "successful bounded request",
            observed: "transport-or-decode-failure",
          };
    await options.save(structuredClone(receipt));
    throw error instanceof UpgradeRefusal
      ? error
      : new UpgradeRefusal(
          receipt.error.resource,
          receipt.error.property,
          receipt.error.expected,
          receipt.error.observed,
        );
  }
}
