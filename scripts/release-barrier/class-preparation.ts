import type * as Plan from "alchemy/Plan";
import { State } from "alchemy/State/State";
import { Effect, Option } from "effect";
import type { PreparedPlan } from "./alchemy-plan.ts";
import type { SqliteClassDeclaration, DeclaredChanges } from "./declared-change-schema.ts";
import {
  classEntries,
  classPlanMatches,
  classRequestVerdict,
  type ClassProvider,
  type ClassProgress,
} from "./declared-class-contract.ts";
import { classHistory, type ClassRecord } from "./class-history.ts";
import { classNative } from "./class-native.ts";
import {
  contentDigest,
  expansionContent,
  expansionRequest,
  payloadDigest,
} from "./class-payload.ts";
import { assertClassObservation } from "./class-observation.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { assertClassRequests } from "./class-refusals.ts";
import { declaredChecks } from "./declared-checks.ts";
import { classCheckFailure, classConstraint } from "./class-refusal.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { withOperation } from "./operation-failure.ts";
import { cloneRequest } from "./class-clone.ts";
import { classRecoveryRequest as recoveryRequest, recordClassProgress } from "./class-recovery.ts";

/** Read every independent baseline and freeze its descriptor before any clone or migration write. */
export const prepareDeclaredClasses = (
  plan: Plan.Plan,
  prepared: PreparedPlan,
  declarations: DeclaredChanges | undefined,
  scope: { stack: string; stage: string },
  candidate: string,
  provider: ClassProvider,
  record?: (value: ClassProgress) => Promise<void>,
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const history = classHistory(yield* state.getOutput(scope));
    const entries = classEntries(declarations);
    if (!entries.length && !Object.keys(history).length) return [];
    if (!record) {
      const refusals = entries.map((entry) => ({
        reason: "declared-class-evidence-required",
        fqn: entry.fqn,
        type: entry.type,
        changed: [{ path: "$evidence", old: "configured", new: null }],
      }));
      throw new BarrierRefusal(
        "declared-class-evidence-required",
        entries[0]?.fqn,
        undefined,
        refusals,
      );
    }
    const call = <A>(
      fqn: string,
      operation: "read-class-expansion" | "deploy-class-expansion",
      fn: () => Promise<A>,
    ) =>
      Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(withOperation(fqn, operation));
    const progress = (fqn: string, saved: ClassRecord, outcome: ClassProgress["outcome"]) =>
      recordClassProgress(record!, fqn, saved, outcome);
    type PreparedClass = {
      entry: SqliteClassDeclaration;
      node: Plan.Apply;
      saved: ClassRecord;
      fresh: boolean;
    };
    const targets = yield* declaredChecks(
      [
        {
          fqn: "(Worker requests)",
          check: Effect.sync(() => assertClassRequests(prepared, entries, history)).pipe(
            Effect.as(Option.none<PreparedClass>()),
          ),
        },
        ...entries.map((entry) => ({
          fqn: entry.fqn,
          check: Effect.gen(function* () {
            const node = plan.resources[entry.fqn];
            const upload = prepared.captured.get(entry.fqn);
            if (!node || !upload || !classPlanMatches(node, entry))
              throw classConstraint(
                "declaration-does-not-match-plan",
                entry.fqn,
                "$prepared.request",
                "captured-existing-worker",
                node && upload ? node.action : null,
              );
            const saved = history[entry.fqn];
            const native = yield* classNative(node, scope, saved);
            if (
              native.attr.accountId !== upload.request.accountId ||
              native.attr.workerName !== upload.request.scriptName
            )
              throw declaredMismatch(
                "declared-class-native-target-drift",
                entry.fqn,
                { accountId: native.attr.accountId, scriptName: native.attr.workerName },
                { accountId: upload.request.accountId, scriptName: upload.request.scriptName },
                entry.type,
              );
            const observed = yield* call(entry.fqn, "read-class-expansion", () =>
              provider.read(upload.request),
            );
            if (observed.workerId !== native.attr.workerId)
              throw declaredMismatch(
                "declared-class-native-target-drift",
                entry.fqn,
                { workerIdentityHash: digest(native.attr.workerId) },
                { workerIdentityHash: digest(observed.workerId) },
                entry.type,
              );
            if (saved) {
              if (saved.entry !== digest(canonical(entry)))
                throw declaredMismatch(
                  "declared-class-declaration-drift",
                  entry.fqn,
                  { entry: saved.entry },
                  { entry: digest(canonical(entry)) },
                  entry.type,
                );
              recoveryRequest(saved, entry.fqn);
              if (
                !["clone-pending", "clone-ready"].includes(saved.status) &&
                saved.status !== "ready" &&
                observed.versionId === saved.baseline.versionId
              )
                throw classConstraint(
                  "declared-class-outcome-unknown",
                  entry.fqn,
                  "$expansion.outcome",
                  "observed-additive-deployment",
                  saved.status,
                );
              if (["clone-pending", "clone-ready"].includes(saved.status)) {
                return Option.some({ entry, node, saved, fresh: true });
              }
              assertClassObservation(entry, saved, observed, saved.status !== "ready");
              if (saved.status !== "ready") {
                const actual = yield* call(entry.fqn, "read-class-expansion", () =>
                  provider.content(observed, observed.versionId),
                );
                if (contentDigest(actual) !== saved.content)
                  throw classConstraint(
                    "declared-class-expansion-unattributable",
                    entry.fqn,
                    "contentHash",
                    saved.content,
                    contentDigest(actual),
                  );
              }
              if (
                !entry.addedBindings.every((expected) =>
                  upload.request.metadata.bindings?.some(
                    (binding) =>
                      binding.type === "durable_object_namespace" &&
                      binding.name === expected.name &&
                      binding.className === expected.className &&
                      (!binding.scriptName || binding.scriptName === observed.scriptName),
                  ),
                )
              )
                throw declaredMismatch(
                  "declared-class-binding-mismatch",
                  entry.fqn,
                  { bindings: entry.addedBindings },
                  { bindings: upload.request.metadata.bindings },
                  entry.type,
                );
              const next = { ...saved, observed };
              return Option.some({ entry, node, saved: next, fresh: false });
            }
            const verdict = classRequestVerdict(upload, entry);
            if (
              observed.accountId !== upload.request.accountId ||
              observed.scriptName !== upload.request.scriptName ||
              observed.migrationTag !== verdict.oldTag ||
              canonical(observed.settings) !== canonical(upload.previousSettings)
            )
              throw declaredMismatch(
                "declared-class-live-baseline-drift",
                entry.fqn,
                { settings: upload.previousSettings, migrationTag: verdict.oldTag },
                { settings: observed.settings, migrationTag: observed.migrationTag },
                entry.type,
              );
            if (
              upload.request.metadata.assets ||
              upload.request.metadata.keepAssets ||
              upload.request.metadata.containers?.length
            )
              throw declaredMismatch(
                "declared-class-worker-mode-unsupported",
                entry.fqn,
                { assets: null, keepAssets: null, containers: [] },
                {
                  assets: upload.request.metadata.assets,
                  keepAssets: upload.request.metadata.keepAssets,
                  containers: upload.request.metadata.containers,
                },
                entry.type,
              );
            const baselineContent = yield* call(entry.fqn, "read-class-expansion", () =>
              provider.content(observed, observed.versionId),
            );
            const content = expansionContent(baselineContent, entry);
            const marker = `basalt-declared:${candidate}:${verdict.entry}`;
            const request = expansionRequest(
              observed,
              content,
              entry,
              verdict.newTag,
              upload.request.metadata.tags ?? [],
              marker,
            );
            const clone = cloneRequest(observed, baselineContent, marker, entry.fqn);
            const descriptor: ClassRecord = {
              entry: verdict.entry,
              declaration: digest(canonical(declarations)),
              candidate,
              native: {
                instanceId: native.instanceId,
                workerId: native.attr.workerId,
                providerVersion: native.providerVersion,
                mode: native.providerMode,
              },
              baseline: observed,
              newTag: verdict.newTag,
              marker,
              content: contentDigest(content),
              payload: payloadDigest(request, content),
              tags: [...(request.metadata.tags ?? [])],
              recovery: {
                metadata: request.metadata,
                mainModule: content.mainModule,
                files: content.files.map((file) => ({
                  name: file.name,
                  type: file.type,
                  base64: Buffer.from(file.bytes).toString("base64"),
                })),
              },
              clone: { request: clone, payload: digest(canonical(clone)), status: "pending" },
              status: "clone-ready",
            };
            yield* progress(entry.fqn, descriptor, "planned");
            return Option.some({ entry, node, saved: descriptor, fresh: true });
          }),
        })),
      ],
      classCheckFailure,
    );
    return targets.flatMap((target) => (Option.isSome(target) ? [target.value] : []));
  });
