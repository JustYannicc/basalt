import { object, text, number } from "./http.ts";
import { decodeReceipt } from "./remote.ts";
import { dictionary } from "./dictionary.ts";
import { decodeInitialState } from "./import-state.ts";
import {
  safePath,
  maximumFileBytes,
  type Baseline,
  type Edit,
  type Pending,
  type SyncState,
} from "./types.ts";
const revision = (value: unknown) => {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value))
    throw new Error("Saved sync revision is invalid");
  return value;
};
const nullableRevision = (value: unknown) => (value === null ? null : revision(value));
const path = (value: string) => {
  if (!safePath(value)) throw new Error("Saved sync path is invalid");
  return value;
};
const content = (value: unknown) => {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > maximumFileBytes ||
    new TextEncoder().encode(value).length > maximumFileBytes
  )
    throw new Error("Saved sync edit is invalid");
  return value;
};
const hashes = (input: unknown) =>
  dictionary(
    Object.entries(object(input)).map(([key, value]) => [path(key), nullableRevision(value)]),
  );
export function decodeState(input: unknown): SyncState | null {
  if (input === null || input === undefined) return null;
  const data = object(input);
  if (data.version !== 1) throw new Error("Saved sync state needs a different plugin version");
  const files = dictionary<Baseline>();
  for (const [key, value] of Object.entries(object(data.files))) {
    const item = object(value);
    files[path(key)] = {
      at: revision(item.at),
      local: nullableRevision(item.local),
      cloud: nullableRevision(item.cloud),
    };
  }
  let pending: Pending | null = null;
  if (data.pending !== null) {
    const item = object(data.pending),
      request = object(item.request);
    if (
      (item.kind !== "apply" && item.kind !== "resolve") ||
      !Array.isArray(request.edits) ||
      !request.edits.length ||
      request.edits.length > 100
    )
      throw new Error("Saved sync operation is invalid");
    const edits: Edit[] = request.edits.map((value) => {
      const edit = object(value);
      return { path: path(text(edit, "path")), content: content(edit.content) };
    });
    const operation = text(request, "operation");
    if (operation.length > 128) throw new Error("Saved sync operation id is invalid");
    const attempts = number(item, "attempts");
    if (!Number.isSafeInteger(attempts) || attempts < 0)
      throw new Error("Saved sync attempt count is invalid");
    const sent = hashes(item.sent);
    if (edits.some((edit) => !(edit.path in sent)))
      throw new Error("Saved sync operation has no file hashes");
    pending = {
      kind: item.kind,
      request: { base: revision(request.base), operation, edits },
      sent,
      attempts,
    };
    if (item.resolution !== undefined) {
      const value = object(item.resolution);
      pending.resolution = {
        ref: text(value, "ref"),
        expected: revision(value.expected),
        main: revision(value.main),
      };
    }
    if (item.kind === "resolve" && !pending.resolution)
      throw new Error("Saved conflict resolution is incomplete");
    if (item.before !== undefined)
      pending.before = dictionary(
        Object.entries(object(item.before)).map(([key, value]) => [path(key), content(value)]),
      );
  }
  if (!Array.isArray(data.conflicts) || !Array.isArray(data.unsupported))
    throw new Error("Saved sync state is incomplete");
  const conflicts = data.conflicts.map((value) => {
    const receipt = decodeReceipt(value);
    if (receipt.state !== "conflict") throw new Error("Saved conflict receipt is invalid");
    return receipt;
  });
  const unsupported = data.unsupported.map((value) => {
    if (typeof value !== "string") throw new Error("Saved unsupported path is invalid");
    return value;
  });
  const initial = decodeInitialState(data.initial);
  return {
    ...(initial ? { initial } : {}),
    version: 1,
    importId: text(data, "importId"),
    head: nullableRevision(data.head),
    importBase: data.importBase === undefined ? null : nullableRevision(data.importBase),
    pulledHead: data.pulledHead === undefined ? null : nullableRevision(data.pulledHead),
    files,
    pending,
    conflicts,
    unsupported,
  };
}
