import type * as Plan from "alchemy/Plan";
import type { PreparedPlan } from "./alchemy-plan.ts";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import { State } from "alchemy/State/State";
import { Effect } from "effect";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import {
  classEntries,
  classPlanMatches,
  classRequestVerdict,
  type ClassProvider,
  type ClassProgress,
  type ClassContent,
} from "./declared-class-contract.ts";
import { classHistory, saveClassHistory, type ClassRecord } from "./class-history.ts";
import { classNative, commitClassNative } from "./class-native.ts";
import {
  contentDigest,
  expansionContent,
  expansionRequest,
  payloadDigest,
} from "./class-payload.ts";
import { assertClassObservation } from "./class-observation.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { assertClassRequests } from "./class-refusals.ts";
import { withOperation } from "./operation-failure.ts";
import { cloneRequest, prepareClassClone, removeClassClone } from "./class-clone.ts";
import { classRecoveryRequest as recoveryRequest, recordClassProgress } from "./class-recovery.ts";

/** A migration is an explicit live expansion before candidate admission. Every resume first observes attribution; no branch repeats a PUT. */
export const expandDeclaredClasses = (
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
    if (!entries.length && !Object.keys(history).length) return false;
    assertClassRequests(prepared, entries, history);
    if (!record) throw new BarrierRefusal("declared-class-evidence-required");
    const targets: {
      entry: (typeof entries)[number];
      node: Plan.Apply;
      saved: ClassRecord;
      fresh: boolean;
    }[] = [];
    const call = <A>(
      fqn: string,
      operation: "read-class-expansion" | "deploy-class-expansion",
      fn: () => Promise<A>,
    ) =>
      Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(withOperation(fqn, operation));
    const progress = (fqn: string, saved: ClassRecord, outcome: ClassProgress["outcome"]) =>
      recordClassProgress(record!, fqn, saved, outcome);
    for (const entry of entries) {
      const node = plan.resources[entry.fqn];
      const upload = prepared.captured.get(entry.fqn);
      if (!node || !upload || !classPlanMatches(node, entry))
        throw new BarrierRefusal("declaration-does-not-match-plan", entry.fqn);
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
          upload.request,
          entry.type,
        );
      const observed = yield* call(entry.fqn, "read-class-expansion", () =>
        provider.read(upload.request),
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
        recoveryRequest(saved);
        if (
          !["clone-pending", "clone-ready"].includes(saved.status) &&
          saved.status !== "ready" &&
          observed.versionId === saved.baseline.versionId
        )
          throw new BarrierRefusal("declared-class-outcome-unknown", entry.fqn);
        if (["clone-pending", "clone-ready"].includes(saved.status)) {
          targets.push({ entry, node, saved, fresh: true });
          continue;
        }
        assertClassObservation(entry, saved, observed, saved.status !== "ready");
        if (saved.status !== "ready") {
          const actual = yield* call(entry.fqn, "read-class-expansion", () =>
            provider.content(observed, observed.versionId),
          );
          if (contentDigest(actual) !== saved.content)
            throw new BarrierRefusal("declared-class-expansion-unattributable", entry.fqn);
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
          throw new BarrierRefusal("declared-class-binding-mismatch", entry.fqn);
        const next = { ...saved, observed };
        targets.push({ entry, node, saved: next, fresh: false });
        continue;
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
        throw new BarrierRefusal("declared-class-worker-mode-unsupported", entry.fqn);
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
      const clone = cloneRequest(observed, baselineContent, marker);
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
      targets.push({ entry, node, saved: descriptor, fresh: true });
    }
    let changed = false;
    for (const target of targets) {
      const { entry, node } = target;
      let saved = target.saved;
      if (target.fresh) {
        yield* classNative(node, scope);
        const current = yield* call(entry.fqn, "read-class-expansion", () =>
          provider.read(saved.baseline),
        );
        if (canonical(current) !== canonical(saved.baseline))
          throw declaredMismatch(
            "declared-class-live-baseline-drift",
            entry.fqn,
            saved.baseline,
            current,
            entry.type,
          );
        saved = yield* prepareClassClone(entry.fqn, saved, scope, provider, (value) =>
          progress(entry.fqn, value, "planned"),
        );
        yield* progress(entry.fqn, saved, "planned");
        saved = { ...saved, status: "pending" };
        yield* saveClassHistory(scope, entry.fqn, saved);
        yield* progress(entry.fqn, saved, "pending");
        const result = yield* call(entry.fqn, "deploy-class-expansion", () =>
          provider.deploy(recoveryRequest(saved)),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* progress(entry.fqn, saved, "unknown");
              return yield* Effect.failCause(cause);
            }),
          ),
        );
        saved = { ...saved, status: "acknowledged", startupTimeMs: result.startupTimeMs };
        yield* saveClassHistory(scope, entry.fqn, saved);
        yield* progress(entry.fqn, saved, "acknowledged");
        if (result.migrationTag !== saved.newTag)
          throw declaredMismatch(
            "declared-class-deployment-tag-mismatch",
            entry.fqn,
            { migrationTag: saved.newTag },
            { migrationTag: result.migrationTag ?? null },
            entry.type,
          );
        const observed = yield* call(entry.fqn, "read-class-expansion", () =>
          provider.read(saved.baseline),
        );
        assertClassObservation(entry, saved, observed, true);
        const actual = yield* call(entry.fqn, "read-class-expansion", () =>
          provider.content(observed, observed.versionId),
        );
        if (contentDigest(actual) !== saved.content)
          throw new BarrierRefusal("declared-class-expansion-unattributable", entry.fqn);
        saved = { ...saved, observed };
      }
      saved = yield* removeClassClone(entry.fqn, saved, scope, provider);
      if (saved.status !== "ready") {
        if (
          !Number.isFinite(saved.startupTimeMs) ||
          saved.startupTimeMs! < 0 ||
          saved.startupTimeMs! > 750
        )
          throw new BarrierRefusal("declared-class-post-deployment-startup-refused", entry.fqn);
        yield* commitClassNative(node, scope, saved, saved.observed!);
        saved = { ...saved, status: "ready" };
        yield* saveClassHistory(scope, entry.fqn, saved);
        changed = true;
      }
      yield* progress(entry.fqn, saved, "ready");
    }
    return changed;
  });
