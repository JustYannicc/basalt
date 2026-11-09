import { object, text, number } from "./http.ts";
import { dictionary } from "./dictionary.ts";
import { safePath } from "./types.ts";
import type { ImportEntry, ImportPlan, InitialState } from "./import-types.ts";
export function decodeImportEntry(raw: unknown): ImportEntry {
  const value = object(raw),
    path = text(value, "path"),
    hash = text(value, "hash"),
    bytes = number(value, "bytes");
  if (
    !safePath(path) ||
    (value.kind !== "note" && value.kind !== "attachment") ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    !new RegExp(`^[a-f0-9]{${value.kind === "note" ? 40 : 64}}$`, "u").test(hash)
  )
    throw new Error("Invalid saved initial import file");
  return { path, hash, bytes, kind: value.kind };
}
export function decodeInitialState(raw: unknown): InitialState | undefined {
  if (raw === undefined) return undefined;
  const data = object(raw);
  if (
    (data.phase !== "planning" && data.phase !== "ready" && data.phase !== "complete") ||
    !Array.isArray(data.entries) ||
    !Number.isSafeInteger(data.nextPage) ||
    typeof data.nextPage !== "number" ||
    data.nextPage < 0
  )
    throw new Error("Invalid saved initial import");
  const done = dictionary<boolean>();
  for (const [path, value] of Object.entries(object(data.done))) {
    if (!safePath(path) || value !== true) throw new Error("Invalid saved import receipt");
    done[path] = true;
  }
  let pending: ImportPlan | null = null;
  if (data.pending !== null) {
    const value = object(data.pending),
      page = number(value, "page");
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      !Array.isArray(value.entries) ||
      typeof value.final !== "boolean"
    )
      throw new Error("Invalid saved import page");
    let removed: string[] | undefined;
    if (value.removed !== undefined) {
      if (
        !Array.isArray(value.removed) ||
        value.removed.some((path) => typeof path !== "string" || !safePath(path))
      )
        throw new Error("Invalid saved removed-source paths");
      removed = value.removed.map((path) => String(path));
    }
    pending = {
      id: text(value, "id"),
      page,
      entries: value.entries.map(decodeImportEntry),
      final: value.final,
      ...(removed ? { removed } : {}),
    };
  }
  return {
    phase: data.phase,
    entries: data.entries.map(decodeImportEntry),
    done,
    nextPage: data.nextPage,
    pending,
  };
}
