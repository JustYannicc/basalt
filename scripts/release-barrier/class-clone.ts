import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Effect, Schema } from "effect";
import type { ClassContent, ClassObservation, ClassProvider } from "./declared-class-contract.ts";
import type { ClassRecord } from "./class-history.ts";
import { saveClassHistory } from "./class-history.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { withOperation } from "./operation-failure.ts";
import { declaredMismatch } from "./declared-refusal.ts";

/** Legacy inherit selects the latest upload. Stage the exact active bytes with version-qualified binding inheritance first. */
export function cloneRequest(
  baseline: ClassObservation,
  content: ClassContent,
  marker: string,
): Workers.CreateBetaWorkerVersionRequest {
  if (baseline.previewUrlsEnabled)
    throw new BarrierRefusal("declared-class-preview-routing-enabled");
  const settings = baseline.settings;
  return Schema.decodeUnknownSync(Schema.toType(Workers.CreateBetaWorkerVersionRequest), {
    onExcessProperty: "error",
  })({
    accountId: baseline.accountId,
    workerId: baseline.scriptName,
    deploy: false,
    mainModule: content.mainModule,
    modules: content.files.map((file) => ({
      name: file.name,
      contentType: file.type,
      contentBase64: Buffer.from(file.bytes).toString("base64"),
    })),
    bindings: (settings.bindings ?? []).map((binding) => ({
      type: "inherit",
      name: binding.name,
      versionId: baseline.versionId,
    })),
    annotations: { ...settings.annotations, workersMessage: `${marker}:clone` },
    compatibilityDate: settings.compatibilityDate ?? undefined,
    compatibilityFlags: settings.compatibilityFlags ?? undefined,
    limits: settings.limits ?? undefined,
    placement: settings.placement ?? undefined,
    usageModel: settings.usageModel ?? undefined,
  });
}

const withoutNull = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutNull)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item != null)
            .map(([key, item]) => [key, withoutNull(item)]),
        )
      : value;

export function assertClone(
  fqn: string,
  saved: ClassRecord,
  actual: Workers.GetBetaWorkerVersionResponse | undefined,
) {
  const request = saved.clone.request;
  const expected = {
    annotations: request.annotations,
    mainModule: request.mainModule,
    modules: request.modules,
    compatibilityDate: request.compatibilityDate,
    compatibilityFlags: request.compatibilityFlags,
    limits: request.limits,
    placement: request.placement,
    usageModel: request.usageModel,
    bindings: saved.baseline.settings.bindings ?? [],
  };
  const observed = actual && {
    annotations: actual.annotations,
    mainModule: actual.mainModule,
    modules: actual.modules,
    compatibilityDate: actual.compatibilityDate,
    compatibilityFlags: actual.compatibilityFlags,
    limits: actual.limits,
    placement: actual.placement,
    usageModel: actual.usageModel,
    bindings: actual.bindings ?? [],
  };
  if (
    !actual ||
    actual.urls.length ||
    actual.assets ||
    actual.cacheOptions ||
    actual.containers?.length ||
    actual.exports ||
    actual.migrations ||
    (saved.clone.versionId && actual.id !== saved.clone.versionId) ||
    canonical(withoutNull(expected)) !== canonical(withoutNull(observed))
  )
    throw declaredMismatch(
      "declared-class-clone-mismatch",
      fqn,
      {
        cloneVersion: saved.clone.versionId ?? "pending",
        payload: saved.clone.payload,
        routed: false,
      },
      {
        cloneVersion: actual?.id ?? null,
        routed: actual?.urls.length ? true : false,
        exactBaseline: false,
      },
      "Cloudflare.Worker",
    );
}

export const prepareClassClone = (
  fqn: string,
  saved: ClassRecord,
  scope: { stack: string; stage: string },
  provider: ClassProvider,
  record: (saved: ClassRecord) => Effect.Effect<void, unknown>,
) =>
  Effect.gen(function* () {
    if (digest(canonical(saved.clone.request)) !== saved.clone.payload)
      throw new BarrierRefusal("declared-class-clone-recovery-invalid", fqn);
    const call = <A>(fn: () => Promise<A>) =>
      Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(
        withOperation(fqn, "stage-class-baseline-clone"),
      );
    const active = yield* call(() => provider.read(saved.baseline));
    if (canonical(active) !== canonical(saved.baseline))
      throw declaredMismatch(
        "declared-class-live-baseline-drift",
        fqn,
        { version: saved.baseline.versionId },
        { version: active.versionId },
        "Cloudflare.Worker",
      );
    let next = saved;
    let actual;
    if (saved.status === "clone-pending") {
      // The intent is durable before POST. A lost reply can only be reconciled by its exact marker and payload, never another POST.
      actual = yield* call(() => provider.clone(saved.baseline, "latest"));
      if (actual?.annotations?.workersMessage !== saved.clone.request.annotations?.workersMessage)
        throw new BarrierRefusal("declared-class-clone-outcome-unknown", fqn);
    } else if (saved.clone.versionId)
      actual = yield* call(() => provider.clone(saved.baseline, saved.clone.versionId!));
    else {
      next = { ...saved, status: "clone-pending" };
      yield* saveClassHistory(scope, fqn, next);
      const result = yield* call(() => provider.stageClone(saved.clone.request));
      next = { ...next, clone: { ...next.clone, versionId: result.versionId } };
      yield* saveClassHistory(scope, fqn, next);
      yield* record(next);
      actual = yield* call(() => provider.clone(saved.baseline, result.versionId));
    }
    assertClone(fqn, next, actual);
    next = {
      ...next,
      status: "clone-ready",
      clone: { ...next.clone, versionId: actual!.id, status: "ready" },
    };
    yield* saveClassHistory(scope, fqn, next);
    yield* record(next);
    const latest = yield* call(() => provider.clone(saved.baseline, "latest"));
    assertClone(fqn, next, latest);
    const confirmed = yield* call(() => provider.read(saved.baseline));
    if (canonical(confirmed) !== canonical(saved.baseline))
      throw new BarrierRefusal("declared-class-live-baseline-drift", fqn);
    return next;
  });

/** Delete only the attributed inactive clone; a lost delete reply is reconciled through GET before any retry. */
export const removeClassClone = (
  fqn: string,
  saved: ClassRecord,
  scope: { stack: string; stage: string },
  provider: ClassProvider,
) =>
  Effect.gen(function* () {
    if (saved.clone.status === "removed" || !saved.clone.versionId) return saved;
    const id = saved.clone.versionId;
    const call = <A>(fn: () => Promise<A>) =>
      Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(
        withOperation(fqn, "stage-class-baseline-clone"),
      );
    const active = yield* call(() => provider.read(saved.baseline));
    if (active.versionId === id)
      throw new BarrierRefusal("declared-class-clone-active-refused", fqn);
    const actual = yield* call(() => provider.clone(saved.baseline, id));
    if (actual) {
      assertClone(fqn, saved, actual);
      yield* saveClassHistory(scope, fqn, {
        ...saved,
        clone: { ...saved.clone, status: "removal-pending" },
      });
      yield* call(() => provider.removeClone(saved.baseline, id));
      if (yield* call(() => provider.clone(saved.baseline, id)))
        throw new BarrierRefusal("declared-class-clone-removal-unconfirmed", fqn);
    }
    const next = { ...saved, clone: { ...saved.clone, status: "removed" as const } };
    yield* saveClassHistory(scope, fqn, next);
    return next;
  });
