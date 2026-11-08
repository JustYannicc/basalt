import type * as Plan from "alchemy/Plan";
import type { PreparedPlan } from "./alchemy-plan.ts";
import type { DeclaredChanges } from "./declared-change-schema.ts";
import { Effect } from "effect";
import { canonical } from "./manifest.ts";
import { classConstraint } from "./class-refusal.ts";
import type { ClassProvider, ClassProgress } from "./declared-class-contract.ts";
import { saveClassHistory, type ClassRecord } from "./class-history.ts";
import { classNative, commitClassNative } from "./class-native.ts";
import { contentDigest } from "./class-payload.ts";
import { assertClassObservation } from "./class-observation.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { withOperation } from "./operation-failure.ts";
import { prepareClassClone, removeClassClone } from "./class-clone.ts";
import { classRecoveryRequest as recoveryRequest, recordClassProgress } from "./class-recovery.ts";
import { prepareDeclaredClasses } from "./class-preparation.ts";

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
    const targets = yield* prepareDeclaredClasses(
      plan,
      prepared,
      declarations,
      scope,
      candidate,
      provider,
      record,
    );
    const call = <A>(
      fqn: string,
      operation: "read-class-expansion" | "deploy-class-expansion",
      fn: () => Promise<A>,
    ) =>
      Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(withOperation(fqn, operation));
    const progress = (fqn: string, saved: ClassRecord, outcome: ClassProgress["outcome"]) =>
      recordClassProgress(record!, fqn, saved, outcome);
    let changed = false;
    for (const target of targets) {
      const { entry, node } = target;
      let saved = target.saved;
      if (target.fresh) {
        yield* classNative(node, scope, saved);
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
        yield* classNative(node, scope, saved);
        yield* progress(entry.fqn, saved, "planned");
        saved = { ...saved, status: "pending" };
        yield* saveClassHistory(scope, entry.fqn, saved);
        yield* progress(entry.fqn, saved, "pending");
        const result = yield* call(entry.fqn, "deploy-class-expansion", () =>
          provider.deploy(recoveryRequest(saved, entry.fqn)),
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
          throw classConstraint(
            "declared-class-expansion-unattributable",
            entry.fqn,
            "contentHash",
            saved.content,
            contentDigest(actual),
          );
        saved = { ...saved, observed };
      }
      saved = yield* removeClassClone(entry.fqn, saved, scope, provider);
      if (saved.status !== "ready") {
        if (
          !Number.isFinite(saved.startupTimeMs) ||
          saved.startupTimeMs! < 0 ||
          saved.startupTimeMs! > 750
        )
          throw classConstraint(
            "declared-class-post-deployment-startup-refused",
            entry.fqn,
            "startupTimeMs",
            "0..750",
            Number.isFinite(saved.startupTimeMs) ? saved.startupTimeMs! : "unconfirmed",
          );
        yield* commitClassNative(node, scope, saved, saved.observed!);
        saved = { ...saved, status: "ready" };
        yield* saveClassHistory(scope, entry.fqn, saved);
        changed = true;
      }
      yield* progress(entry.fqn, saved, "ready");
    }
    return changed;
  });
