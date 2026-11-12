import { json, type Schema } from "apps";
import { createAppClient, queryReference, type OperationReference } from "apps/client";
import type { attachmentTools } from "../attachments.ts";
import type { importTools } from "../imports.ts";
import type { listNotes, readAttachment, readNote, searchNotes } from "../index.ts";
import type { Devices, ImportStatus, Version } from "./model.ts";

const client = createAppClient();
// The tools return their drive results unchanged; the page reads them as the tools declare.
const run = <I, O>(reference: OperationReference<I, O, "query">, input: NoInfer<I>): Promise<O> =>
  client.query(reference, input, json() as unknown as Schema<O, boolean>);

const tools = {
  listNotes: queryReference<typeof listNotes>("listNotes"),
  readNote: queryReference<typeof readNote>("readNote"),
  searchNotes: queryReference<typeof searchNotes>("searchNotes"),
  readAttachment: queryReference<typeof readAttachment>("readAttachment"),
  importStatus: queryReference<(typeof importTools)["importStatus"]>("importStatus"),
  fileInfo: queryReference<(typeof attachmentTools)["fileInfo"]>("fileInfo"),
};
// History filtered by note and device sync records come from the vault-storage server; an older
// server refuses `path` and has no `devices`, and the page degrades.
const named = <I, O>(tool: string) =>
  queryReference<never>(tool as never) as unknown as OperationReference<I, O, "query">;
const historyTool = named<
  { readonly path?: string; readonly at?: string; readonly limit?: number },
  readonly Version[]
>("history");
const devicesTool = named<Record<string, never>, Devices>("devices");

type ListPage = Awaited<ReturnType<typeof list>>;
export type Entry = ListPage["entries"][number];
export type Match = Awaited<ReturnType<typeof search>>[number];

/** Page through one folder of the vault, pinned to one version. */
async function list(path: string | undefined, at?: string) {
  const result = await run(tools.listNotes, {
    ...(path === undefined ? {} : { path }),
    ...(at === undefined ? {} : { at }),
    limit: 500,
  });
  const entries = [...result.entries];
  let next = result.next;
  for (let page = 1; next !== null && page < 20; page++) {
    const more = await run(tools.listNotes, { at: result.at, cursor: next, limit: 500 });
    entries.push(...more.entries);
    next = more.next;
  }
  // A folder past 20 pages is cut off; `complete` says so.
  return { at: result.at, entries, complete: next === null };
}

/** Up to 1 MiB of a note: the reader shows text, not attachments. */
async function read(path: string, at?: string): Promise<string | null> {
  let content = "";
  let offset = 0;
  for (let page = 0; page < 4; page++) {
    const result = await run(tools.readNote, {
      path,
      ...(at === undefined ? {} : { at }),
      ...(offset === 0 ? {} : { offset }),
    });
    if (result === null) return page === 0 ? null : content;
    content += result.content;
    if (result.next === null) break;
    offset = result.next;
  }
  return content;
}

/** Text matches across the vault; each page scans a bounded number of files, so follow a few. */
async function search(query: string) {
  const first = await run(tools.searchNotes, { query, limit: 50, maxFiles: 50 });
  const matches = [...first.matches];
  let cursor = first.cursor;
  let complete = first.complete;
  for (let page = 1; !complete && cursor !== null && page < 8 && matches.length < 50; page++) {
    const more = await run(tools.searchNotes, {
      query,
      at: first.at,
      cursor,
      limit: 50,
      maxFiles: 50,
    });
    matches.push(...more.matches);
    complete = more.complete;
    cursor = more.cursor;
  }
  return matches.slice(0, 50);
}

/**
 * Every path in the vault at one version, for wikilink resolution and the file count. Folders
 * load a few at a time; huge vaults stop at `limit`.
 */
async function walk(limit = 20000): Promise<{ paths: string[]; complete: boolean }> {
  const root = await list(undefined);
  const paths: string[] = [];
  let folders: string[] = [];
  let cut = !root.complete;
  const take = (entries: readonly Entry[]) => {
    for (const entry of entries) {
      if (paths.length >= limit) {
        cut = true;
        return;
      }
      if (entry.kind === "directory") folders.push(entry.path);
      else paths.push(entry.path);
    }
  };
  take(root.entries);
  while (folders.length && paths.length < limit) {
    const batch = folders.slice(0, 4);
    folders = folders.slice(4);
    for (const page of await Promise.all(batch.map((path) => list(path, root.at)))) {
      cut ||= !page.complete;
      take(page.entries);
    }
  }
  return { paths, complete: !cut && folders.length === 0 };
}

const maxAttachmentBytes = 8 * 1024 * 1024;

/** An image's bytes, read only when the drive says it is small enough to show. */
async function attachment(path: string, type: string): Promise<Blob | null> {
  const info = await run(tools.fileInfo, { path });
  if (info === null) return null;
  const size = info.attachment?.bytes ?? info.bytes;
  if (size > maxAttachmentBytes) return null;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (let page = 0; page < 256; page++) {
    const result = await run(tools.readAttachment, {
      path,
      at: info.at,
      ...(offset === 0 ? {} : { offset }),
    });
    if (result === null) return null;
    const text = atob(result.contentBase64);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    parts.push(bytes);
    if (result.next === null) return new Blob(parts, { type });
    offset = result.next;
  }
  return null;
}

/**
 * One note's dated versions, newest first, or null where the server can't answer per note: a
 * drive without per-file history refuses `path`, and one without commit times leaves `time` out.
 */
async function noteHistory(path: string, limit: number): Promise<Version[] | null> {
  const versions: readonly Version[] | null = await run(historyTool, { path, limit }).catch(
    () => null,
  );
  return versions !== null && versions.every((version) => typeof version.time === "string")
    ? [...versions]
    : null;
}

export const vault = {
  importStatus: (): Promise<ImportStatus | null> => run(tools.importStatus, {}).catch(() => null),
  list,
  read,
  search,
  walk,
  attachment,
  noteHistory,
  /** The vault's newest version; dated once the server records commit times. */
  latest: (): Promise<Version | null> =>
    run(historyTool, { limit: 1 })
      .then((versions: readonly Version[]) => versions[0] ?? null)
      .catch(() => null),
  devices: () => run(devicesTool, {}).catch(() => null),
};
export type VaultApi = typeof vault;
