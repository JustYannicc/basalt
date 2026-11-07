import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { State, isResourceState } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import { classHistory } from "./class-history.ts";
import { classNamespaces, classTag, type ClassTarget } from "./declared-class-contract.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { classRecoveryRequest } from "./class-recovery.ts";
import type { RecoveryManifest } from "./recovery-manifest.ts";
import { canonical } from "./manifest.ts";

const bindings = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    name: Schema.String,
    namespaceId: Schema.optional(Schema.String),
    namespace_id: Schema.optional(Schema.String),
    className: Schema.optional(Schema.String),
    class_name: Schema.optional(Schema.String),
  }),
);

/** Cloudflare forbids rollback across class lifecycle changes. Check every retained class before any Worker or container recovery write. */
export const verifyClassRollback = (
  scope: { stack: string; stage: string },
  manifest: RecoveryManifest,
  targets: ReadonlyMap<string, ClassTarget>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const history = classHistory(yield* state.getOutput(scope));
    for (const [fqn, saved] of Object.entries(history)) {
      const target = targets.get(fqn);
      const worker = manifest.workers.find((worker) => worker.id === fqn);
      const native = yield* state.get({ ...scope, fqn });
      const fail = (reason: string, expected: unknown, actual: unknown): never => {
        throw declaredMismatch(reason, fqn, expected, actual, "Cloudflare.Worker");
      };
      if (
        !target ||
        !worker ||
        saved.status !== "ready" ||
        !saved.observed ||
        !isResourceState(native) ||
        (native.status !== "created" && native.status !== "updated") ||
        native.instanceId !== saved.native.instanceId ||
        native.providerVersion !== saved.native.providerVersion ||
        native.providerMode !== saved.native.mode ||
        native.attr.workerId !== saved.native.workerId ||
        native.attr.accountId !== saved.baseline.accountId ||
        native.attr.workerName !== saved.baseline.scriptName ||
        canonical(native.attr.durableObjectNamespaces) !==
          canonical(classNamespaces(saved.observed)) ||
        target.accountId !== saved.baseline.accountId ||
        target.scriptName !== saved.baseline.scriptName
      )
        fail(
          "declared-class-recovery-identity-drift",
          { native: saved.native, status: "ready", target: saved.baseline },
          { native, status: saved.status, target },
        );
      classRecoveryRequest(saved);
      const live = yield* Workers.getScriptScriptAndVersionSetting(target!).pipe(Retry.none);
      const namespaces = classNamespaces({ scriptName: target!.scriptName, settings: live });
      if (
        classTag(live.tags ?? []) !== saved.newTag ||
        canonical(namespaces) !== canonical(classNamespaces(saved.observed!))
      )
        fail(
          "declared-class-recovery-prerequisite-drift",
          { tag: saved.newTag, namespaces: classNamespaces(saved.observed!) },
          { tag: classTag(live.tags ?? []), namespaces },
        );
      for (const baseline of worker!.baseline) {
        const version = yield* Workers.getScriptVersion({
          ...target!,
          versionId: baseline.versionId,
        }).pipe(Retry.none);
        if (
          version.id !== baseline.versionId ||
          version.resources.scriptRuntime?.migrationTag !== saved.newTag
        )
          fail(
            "declared-class-pre-migration-rollback-refused",
            { migrationTag: saved.newTag },
            { migrationTag: version.resources.scriptRuntime?.migrationTag ?? null },
          );
        const actual = Schema.decodeUnknownSync(bindings)(version.resources.bindings);
        for (const binding of saved.observed!.settings.bindings ?? []) {
          if (
            binding.type !== "durable_object_namespace" ||
            (binding.scriptName && binding.scriptName !== target!.scriptName)
          )
            continue;
          if (
            !actual.some(
              (item) =>
                item.type === binding.type &&
                item.name === binding.name &&
                (item.namespaceId ?? item.namespace_id) === binding.namespaceId,
            ) ||
            !version.resources.script?.namedHandlers?.some(
              (handler) => handler.name === binding.className,
            )
          )
            fail(
              "declared-class-recovery-export-missing",
              { binding },
              { bindings: actual, exports: version.resources.script?.namedHandlers },
            );
        }
      }
    }
  });
