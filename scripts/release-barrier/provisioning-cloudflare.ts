import type * as Plan from "alchemy/Plan";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as DurableObjects from "@distilled.cloud/cloudflare/durable_objects";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect, Stream } from "effect";
import { applyRuntimeCreate, decodeCreatedRuntime } from "./provisioning-apply.ts";
import { containerAttributes } from "./container-observation.ts";
import {
  assertProvisioningEnable,
  type ProvisioningEnable,
  type RuntimeProvisioningManifest,
} from "./provisioning-contract.ts";
import { readRuntimeExports } from "./provisioning-exports.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";
import type { NamespaceBaseline, NamespaceObservation } from "./provisioning-namespace.ts";
import type { RuntimeProvisioningProvider } from "./runtime-provisioning.ts";
import { runtimeNativeState } from "./provisioning-native.ts";

type Services =
  | Effect.Services<ReturnType<typeof applyRuntimeCreate>>
  | Effect.Services<ReturnType<typeof Workers.getBetaWorkerVersion>>;

/** No live caller is installed until the separate provisioning enable decision. */
export const runtimeProvisioningProvider = (input: {
  manifest: RuntimeProvisioningManifest;
  enable: ProvisioningEnable | undefined;
  scriptName: string;
  plan: Plan.Plan;
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
    const deployment = () =>
      run(
        Workers.listScriptDeployments({ accountId, scriptName }).pipe(
          Retry.none,
          Effect.map((result) => {
            const current = result.deployments[0];
            if (
              !current ||
              current.versions.length !== 1 ||
              current.versions[0]!.percentage !== 100
            )
              throw provisioningRefusal(
                "provisioning-Worker-split-or-missing",
                "namespace.deployment",
                "one-version-at-100-percent",
                current?.versions ?? null,
              );
            return { deploymentId: current.id, versionId: current.versions[0]!.versionId };
          }),
        ),
      );
    const version = (versionId: string) =>
      run(
        Workers.getBetaWorkerVersion({
          accountId,
          workerId: scriptName,
          versionId,
          include: "modules",
        }).pipe(Retry.none),
      );
    const namespaces = (source: Workers.GetBetaWorkerVersionResponse) =>
      run(
        Effect.gen(function* () {
          const rows = yield* DurableObjects.listNamespaces
            .items({ accountId })
            .pipe(Stream.runCollect);
          const exports = readRuntimeExports(source.exports);
          return Object.entries(exports)
            .flatMap(([className, exported]) => {
              if (exported.type !== "durable-object") return [];
              const actual = rows.filter(
                (row) => row.script === scriptName && row.class === className,
              );
              const bindings = (source.bindings ?? []).filter(
                (binding) =>
                  binding.type === "durable_object_namespace" &&
                  binding.className === className &&
                  !binding.scriptName,
              );
              if (
                actual.length !== 1 ||
                !actual[0]!.id ||
                actual[0]!.useSqlite !== (exported.storage === "sqlite") ||
                bindings.length !== 1
              )
                throw provisioningRefusal(
                  "provisioning-namespace-readback-incomplete",
                  `namespace.${className}`,
                  "one-owned-namespace-and-local-binding",
                  { namespaces: actual.length, bindings: bindings.length },
                );
              const binding = bindings[0]!;
              if (binding.type !== "durable_object_namespace") return [];
              sameProvisioningValue(
                `namespace.${className}.id`,
                actual[0]!.id,
                binding.namespaceId,
              );
              return [
                { id: actual[0]!.id, className, binding: binding.name, storage: exported.storage },
              ];
            })
            .sort((left, right) => left.className.localeCompare(right.className));
        }).pipe(Retry.none),
      );
    const observeNamespace = async (): Promise<NamespaceObservation> => {
      const current = await deployment();
      const source = await version(current.versionId);
      return {
        accountId,
        scriptName,
        ...current,
        namespaces: await namespaces(source),
        exports: readRuntimeExports(source.exports),
        containers: source.containers ?? [],
      };
    };
    const provider: RuntimeProvisioningProvider = {
      active: input.active,
      namespaceBaseline: async (): Promise<NamespaceBaseline> => {
        const current = await deployment();
        const source = await version(current.versionId);
        return {
          accountId,
          scriptName,
          version: source,
          containers: source.containers ?? [],
          namespaces: await namespaces(source),
        };
      },
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
      readNamespaceVersion: version,
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
      observeNamespace,
      applicationAbsent: async () => {
        const apps = await run(
          Containers.listContainerApplications({ accountId }).pipe(Retry.none),
        );
        return !apps.some((app) => app.name === manifest.declaration.props.name);
      },
      createApplication: (namespaceId) =>
        run(applyRuntimeCreate(input.plan, manifest, namespaceId, input.enable, now)),
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
