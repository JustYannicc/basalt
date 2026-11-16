import type * as Plan from "alchemy/Plan";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect } from "effect";
import { applyRuntimeCreate, decodeCreatedRuntime } from "./provisioning-apply.ts";
import { containerAttributes } from "./container-observation.ts";
import {
  assertProvisioningEnable,
  type ProvisioningEnable,
  type RuntimeProvisioningManifest,
} from "./provisioning-contract.ts";
import { runtimeNamespaceReader } from "./runtime-namespace-read.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";
import type { RuntimeProvisioningProvider } from "./runtime-provisioning.ts";
import { runtimeNativeState } from "./provisioning-native.ts";

type Services =
  | Effect.Services<ReturnType<typeof applyRuntimeCreate>>
  | Effect.Services<ReturnType<typeof Workers.getBetaWorkerVersion>>;

/** The separate main-only provisioning workflow admits this provider under its exact reviewed GO. */
export const runtimeProvisioningProvider = (input: {
  manifest: RuntimeProvisioningManifest;
  enable: ProvisioningEnable | undefined;
  scriptName: string;
  plan: Plan.Plan | ((namespaceId: string) => Promise<Plan.Plan>);
  active: RuntimeProvisioningProvider["active"];
  now?: () => number;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Services>();
    const run = Effect.runPromiseWith(context);
    const { manifest, scriptName } = input;
    const accountId = manifest.declaration.accountId;
    const now = input.now ?? Date.now;
    const enabled = () => assertProvisioningEnable(manifest, input.enable, now());
    const namespaces = yield* runtimeNamespaceReader(accountId, scriptName);
    const provider: RuntimeProvisioningProvider = {
      active: input.active,
      namespaceBaseline: namespaces.baseline,
      stageNamespace: async (request) => {
        enabled();
        sameProvisioningValue(
          "namespace.stage.target",
          { accountId, workerId: scriptName, deploy: false },
          { accountId: request.accountId, workerId: request.workerId, deploy: request.deploy },
        );
        const result = await run(Workers.createBetaWorkerVersion(request).pipe(Retry.none));
        return { versionId: result.id };
      },
      readNamespaceVersion: namespaces.version,
      activateNamespace: async (versionId) => {
        enabled();
        const result = await run(
          Workers.createScriptDeployment({
            accountId,
            scriptName,
            strategy: "percentage",
            versions: [{ percentage: 100, versionId }],
            annotations: { workersMessage: `runtime-provisioning:${manifest.operationId}` },
          }).pipe(Retry.none),
        );
        sameProvisioningValue(
          "namespace.activation.versions",
          [{ percentage: 100, versionId }],
          result.versions,
        );
        return { deploymentId: result.id };
      },
      observeNamespace: namespaces.observe,
      applicationAbsent: async () => {
        const apps = await run(
          Containers.listContainerApplications({ accountId }).pipe(Retry.none),
        );
        return !apps.some((app) => app.name === manifest.declaration.props.name);
      },
      createApplication: async (namespaceId) => {
        const plan = typeof input.plan === "function" ? await input.plan(namespaceId) : input.plan;
        return run(applyRuntimeCreate(plan, manifest, namespaceId, input.enable, now));
      },
      readApplication: async (applicationId) =>
        decodeCreatedRuntime(
          containerAttributes(
            await run(
              Containers.getContainerApplication({ accountId, applicationId }).pipe(Retry.none),
            ),
          ),
        ),
      nativeState: (namespaceId) => run(runtimeNativeState(manifest, namespaceId)),
    };
    return provider;
  });
