import * as DurableObjects from "@distilled.cloud/cloudflare/durable_objects";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect, Stream } from "effect";
import { readRuntimeExports } from "./provisioning-exports.ts";
import { provisioningRefusal, sameProvisioningValue } from "./provisioning-refusal.ts";
import type { NamespaceBaseline, NamespaceObservation } from "./provisioning-namespace.ts";

/** Observe a namespace baseline before constructing any write authority. */
export const runtimeNamespaceReader = (accountId: string, scriptName: string) =>
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof Workers.getBetaWorkerVersion>>>();
    const run = Effect.runPromiseWith(context);
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
          return Object.entries(readRuntimeExports(source.exports))
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
    return {
      version,
      baseline: async (): Promise<NamespaceBaseline> => {
        const current = await deployment(),
          source = await version(current.versionId);
        return {
          accountId,
          scriptName,
          version: source,
          containers: source.containers ?? [],
          namespaces: await namespaces(source),
        };
      },
      observe: async (): Promise<NamespaceObservation> => {
        const current = await deployment(),
          source = await version(current.versionId);
        return {
          accountId,
          scriptName,
          ...current,
          namespaces: await namespaces(source),
          exports: readRuntimeExports(source.exports),
          containers: source.containers ?? [],
        };
      },
    };
  });
