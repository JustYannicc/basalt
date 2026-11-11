import type { CollectionDiagnostic, QuotaFieldPresence } from "../../apps/pool/contract.ts";
import { digest } from "./backend-users.ts";
import { object } from "./json.ts";
import { sourceXaiDiagnostic, xaiCollectionDiagnostic } from "./xai-collection-diagnostic.ts";

function field(value: unknown): QuotaFieldPresence | undefined {
  if (!object(value)) return undefined;
  const { present, null: nil, quantity_null, quantity_valid, five_hour } = value;
  if (
    typeof present !== "boolean" ||
    typeof nil !== "boolean" ||
    typeof quantity_null !== "boolean" ||
    typeof quantity_valid !== "boolean" ||
    typeof five_hour !== "boolean" ||
    (!present && (nil || quantity_null || quantity_valid || five_hour)) ||
    (nil && (quantity_null || quantity_valid || five_hour)) ||
    (quantity_null && quantity_valid)
  )
    return undefined;
  return {
    present,
    null: nil,
    quantityNull: quantity_null,
    quantityValid: quantity_valid,
    fiveHour: five_hour,
  };
}

/** Copy only fixed flags; vendor bodies and quantities have no public representation. */
export function collectionDiagnostic(
  value: unknown,
  provider: string,
): CollectionDiagnostic | undefined {
  if (provider === "xai") return xaiCollectionDiagnostic(value);
  if (
    !object(value) ||
    value.provider !== provider ||
    (provider !== "claude" && provider !== "codex")
  )
    return undefined;
  const at = typeof value.attempted_at === "string" ? Date.parse(value.attempted_at) : NaN;
  if (
    !Number.isFinite(at) ||
    typeof value.response_received !== "boolean" ||
    typeof value.json_valid !== "boolean" ||
    (!value.response_received && value.json_valid)
  )
    return undefined;
  const common = {
    attemptedAt: new Date(at).toISOString(),
    provider,
    responseReceived: value.response_received,
    jsonValid: value.json_valid,
  };
  if (provider === "claude") {
    const fiveHour = field(value.five_hour);
    return fiveHour === undefined ? undefined : { ...common, provider, fiveHour };
  }
  const primaryWindow = field(value.primary_window),
    secondaryWindow = field(value.secondary_window);
  return primaryWindow === undefined || secondaryWindow === undefined
    ? undefined
    : { ...common, provider, primaryWindow, secondaryWindow };
}

function sourceField(value: QuotaFieldPresence) {
  return {
    present: value.present,
    null: value.null,
    quantity_null: value.quantityNull,
    quantity_valid: value.quantityValid,
    five_hour: value.fiveHour,
  };
}

export interface CollectionDiagnosticStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

const pendingWrites = new WeakMap<CollectionDiagnosticStorage, Map<string, Promise<void>>>();

/** Serialize the compare/write across both Home read paths, without blocking other accounts. */
export function retainCollectionDiagnostic(
  value: import("./json.ts").Json,
  id: string,
  storage: CollectionDiagnosticStorage,
) {
  let pending = pendingWrites.get(storage);
  if (pending === undefined) {
    pending = new Map();
    pendingWrites.set(storage, pending);
  }
  const queue = pending;
  const work = (queue.get(id) ?? Promise.resolve()).then(() =>
    persistDiagnostic(value, id, storage),
  );
  const settled = work.then(
    () => {},
    () => {},
  );
  queue.set(id, settled);
  return work.finally(() => {
    if (queue.get(id) === settled) queue.delete(id);
  });
}

async function persistDiagnostic(
  value: import("./json.ts").Json,
  id: string,
  storage: CollectionDiagnosticStorage,
): Promise<import("./json.ts").Json> {
  const collection = object(value.collection) ? value.collection : value;
  const credential = object(value.credential) ? value.credential : value;
  const incoming = object(collection.diagnostic) ? collection.diagnostic : undefined;
  const provider = credential.provider ?? incoming?.provider;
  if (provider !== "claude" && provider !== "codex" && provider !== "xai") return value;
  const key = `quota-field-diagnostic-v1:${await digest(id)}`;
  const retained = collectionDiagnostic(await storage.get(key), provider);
  const current = collectionDiagnostic(incoming, provider);
  const regressiveClaim =
    current?.attemptedAt === retained?.attemptedAt &&
    current?.xai?.phase === "claimed" &&
    retained?.xai !== undefined &&
    retained.xai.phase !== "claimed";
  const latest =
    current !== undefined &&
    !regressiveClaim &&
    (retained === undefined || current.attemptedAt >= retained.attemptedAt)
      ? current
      : retained;
  if (latest === undefined) return value;
  const diagnostic = {
    attempted_at: latest.attemptedAt,
    provider: latest.provider,
    response_received: latest.responseReceived,
    json_valid: latest.jsonValid,
    ...(latest.xai === undefined ? {} : { xai: sourceXaiDiagnostic(latest.xai) }),
    ...(latest.fiveHour === undefined ? {} : { five_hour: sourceField(latest.fiveHour) }),
    ...(latest.primaryWindow === undefined
      ? {}
      : { primary_window: sourceField(latest.primaryWindow) }),
    ...(latest.secondaryWindow === undefined
      ? {}
      : { secondary_window: sourceField(latest.secondaryWindow) }),
  };
  if (latest === current && JSON.stringify(current) !== JSON.stringify(retained))
    await storage.put(key, diagnostic);
  return { ...value, collection: { ...collection, diagnostic } };
}
