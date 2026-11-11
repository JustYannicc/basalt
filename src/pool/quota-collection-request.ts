import {
  collectionRequestDispositions,
  type CollectionRequest,
} from "../../apps/pool/collection-diagnostic-contract.ts";
import type { CollectionDiagnosticStorage } from "./collection-diagnostic.ts";
import { digest } from "./backend-users.ts";
import { object, type Json } from "./json.ts";

function instant(value: unknown): string | undefined {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

export function collectionRequest(value: unknown): CollectionRequest | undefined {
  if (!object(value)) return undefined;
  const requestedAt = instant(value.requested_at);
  const disposition = collectionRequestDispositions.find((item) => item === value.disposition);
  if (requestedAt === undefined || disposition === undefined) return undefined;
  const homeAttemptAt = instant(value.home_attempt_at);
  const nextAllowedAt = instant(value.next_allowed_at);
  return {
    requestedAt,
    disposition,
    ...(homeAttemptAt === undefined ? {} : { homeAttemptAt }),
    ...(nextAllowedAt === undefined ? {} : { nextAllowedAt }),
    ...(typeof value.accepted === "boolean" ? { accepted: value.accepted } : {}),
  };
}

function source(value: CollectionRequest): Json {
  return {
    requested_at: value.requestedAt,
    disposition: value.disposition,
    ...(value.homeAttemptAt === undefined ? {} : { home_attempt_at: value.homeAttemptAt }),
    ...(value.nextAllowedAt === undefined ? {} : { next_allowed_at: value.nextAllowedAt }),
    ...(value.accepted === undefined ? {} : { accepted: value.accepted }),
  };
}

const key = async (id: string) => `quota-collection-request-v1:${await digest(id)}`;
const pendingWrites = new WeakMap<CollectionDiagnosticStorage, Map<string, Promise<void>>>();

function retainRequest(
  storage: CollectionDiagnosticStorage,
  id: string,
  request: CollectionRequest,
) {
  let queue = pendingWrites.get(storage);
  if (queue === undefined) {
    queue = new Map();
    pendingWrites.set(storage, queue);
  }
  const pending = queue;
  const work = (pending.get(id) ?? Promise.resolve()).then(async () => {
    const storageKey = await key(id);
    const retained = collectionRequest(await storage.get(storageKey));
    if (retained !== undefined && retained.requestedAt > request.requestedAt)
      return source(retained);
    const value = source(request);
    await storage.put(storageKey, value);
    return value;
  });
  const settled = work.then(
    () => {},
    () => {},
  );
  pending.set(id, settled);
  return work.finally(() => {
    if (pending.get(id) === settled) pending.delete(id);
  });
}

/** The last pool decision survives Home restarts without changing the Home attempt time. */
export async function retainedCollectionRequest(
  value: Json,
  id: string,
  storage: CollectionDiagnosticStorage,
): Promise<Json> {
  if (!object(value.credential) || value.credential.provider !== "xai") return value;
  const collection = { ...(object(value.collection) ? value.collection : {}) };
  delete collection.request;
  const request = collectionRequest(await storage.get(await key(id)));
  return {
    ...value,
    collection: { ...collection, ...(request === undefined ? {} : { request: source(request) }) },
  };
}

export function traceCollectionRequest(
  initial: Json | null,
  id: string,
  storage: CollectionDiagnosticStorage,
  now: number,
) {
  if (!object(initial?.credential) || initial.credential.provider !== "xai") return undefined;
  const requestedAt = new Date(now).toISOString();
  let accepted: boolean | undefined;
  return {
    accepted(value: boolean) {
      accepted = value;
    },
    async record(
      value: Json | null,
      disposition: CollectionRequest["disposition"],
      nextAllowed?: number,
    ): Promise<Json | null> {
      const collection = object(value?.collection) ? value.collection : {};
      const homeAttemptAt = instant(collection.last_attempt_at);
      const request = await retainRequest(storage, id, {
        requestedAt,
        disposition,
        ...(homeAttemptAt === undefined ? {} : { homeAttemptAt }),
        ...(nextAllowed === undefined
          ? {}
          : { nextAllowedAt: new Date(nextAllowed).toISOString() }),
        ...(accepted === undefined ? {} : { accepted }),
      });
      return value === null ? null : { ...value, collection: { ...collection, request } };
    },
  };
}
