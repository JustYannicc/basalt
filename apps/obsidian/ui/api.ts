import { json, type Schema } from "apps";
import { createAppClient, queryReference, type OperationReference } from "apps/client";
import type { Devices, ImportStatus, Version } from "./model.ts";

export interface Entry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly oid: string;
}
export interface ListPage {
  readonly at: string;
  readonly path: string;
  readonly exists: boolean;
  readonly entries: readonly Entry[];
  readonly next: unknown;
}
export interface ReadResult {
  readonly at: string;
  readonly path: string;
  readonly bytes: number;
  readonly next: number | null;
  readonly content: string;
}
export interface Match {
  readonly path: string;
  readonly line: number;
  readonly excerpt: string;
}
interface SearchPage {
  readonly at: string;
  readonly matches: readonly Match[];
  readonly complete: boolean;
  readonly cursor: unknown;
}

const client = createAppClient();
// The tools return their drive results unchanged; the page reads them as those shapes.
const as = <T>() => json() as unknown as Schema<T, boolean>;
// Some tools (device check-ins, dated per-note history) arrive with a later server, so tools are
// named at runtime and answer with the shape this page expects or fail.
const reference = <T>(tool: string) =>
  queryReference<never>(tool as never) as unknown as OperationReference<object, T, "query">;
const call = <T>(tool: string, input: object): Promise<T> =>
  client.query(reference<T>(tool), input, as<T>());

/** Page through one folder of the vault at a pinned version. */
async function list(path: string | undefined): Promise<{ at: string | null; entries: Entry[] }> {
  const entries: Entry[] = [];
  let cursor: unknown;
  let at: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result: ListPage = await call<ListPage>("listNotes", {
      ...(path === undefined ? {} : { path }),
      ...(at === null ? {} : { at }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: 500,
    });
    at = result.at;
    entries.push(...result.entries);
    if (result.next === null || result.next === undefined) break;
    cursor = result.next;
  }
  return { at, entries };
}

/** Up to 1 MiB of a note: the reader shows text, not attachments. */
async function read(path: string, at?: string): Promise<string | null> {
  let content = "";
  let offset = 0;
  for (let page = 0; page < 4; page++) {
    const result = await call<ReadResult | null>("readNote", {
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
async function search(query: string): Promise<Match[]> {
  const matches: Match[] = [];
  let cursor: unknown;
  let at: string | undefined;
  for (let page = 0; page < 8 && matches.length < 50; page++) {
    const result: SearchPage = await call<SearchPage>("searchNotes", {
      query,
      limit: 50,
      maxFiles: 50,
      ...(at === undefined ? {} : { at }),
      ...(cursor === undefined || cursor === null ? {} : { cursor }),
    });
    at = result.at;
    matches.push(...result.matches);
    if (result.complete || result.cursor === null) break;
    cursor = result.cursor;
  }
  return matches.slice(0, 50);
}

/** Every path in the vault, for wikilink resolution and the file count. Bounded for huge vaults. */
async function walk(limit = 20000): Promise<string[]> {
  const paths: string[] = [];
  const folders: (string | undefined)[] = [undefined];
  while (folders.length && paths.length < limit) {
    const { entries } = await list(folders.shift());
    for (const entry of entries)
      if (entry.kind === "directory") folders.push(entry.path);
      else paths.push(entry.path);
  }
  return paths;
}

interface AttachmentPage {
  readonly contentBase64: string;
  readonly next: number | null;
}
const maxAttachmentBytes = 8 * 1024 * 1024;

async function attachment(path: string, type: string): Promise<Blob | null> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (offset < maxAttachmentBytes) {
    const page = await call<AttachmentPage | null>("readAttachment", {
      path,
      ...(offset === 0 ? {} : { offset }),
    });
    if (page === null) return null;
    const bytes = Uint8Array.from(atob(page.contentBase64), (char) => char.charCodeAt(0));
    parts.push(bytes);
    if (page.next === null) return new Blob(parts, { type });
    offset = page.next;
  }
  return null;
}

export const vault = {
  walk,
  attachment,
  importStatus: () => call<ImportStatus | null>("importStatus", {}).catch(() => null),
  list,
  read,
  search,
  /** Vault-wide when path is omitted. Servers without per-note history reject `path`. */
  history: async (input: {
    path?: string;
    at?: string;
    limit: number;
  }): Promise<Version[] | null> => {
    try {
      const result = await call<unknown>("history", input);
      return Array.isArray(result) ? (result as Version[]) : null;
    } catch {
      return null;
    }
  },
  /** Device check-ins arrive with a later server and plugin; until then this is null. */
  devices: () => call<Devices>("devices", {}).catch(() => null),
};
export type VaultApi = typeof vault;
