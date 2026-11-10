export interface LocalFile {
  path: string;
  bytes: number;
  /** Changes whenever this session observes a local edit, even if its byte count is unchanged. */
  stamp?: string;
}
export interface LocalVault {
  readonly initialSource?: boolean;
  importEntry?(file: LocalFile): Promise<import("./import-types.ts").ImportEntry | null>;
  readonly binary?: boolean;
  files(): Promise<LocalFile[]>;
  read(path: string): Promise<string | null>;
  /**
   * Like read, but never uploads. An attachment changed since its last pointer reads as a value
   * no blob matches, which is all a pull needs to keep it as a local edit.
   */
  inspect?(path: string): Promise<string | null>;
  replace(
    path: string,
    expected: string | null,
    content: string | null,
    context?: { at: string },
  ): Promise<boolean>;
  accept?(path: string, at: string, blob: string | null): Promise<void>;
}
export interface Entry {
  path: string;
  kind: "file" | "directory";
  oid: string;
}
export interface Page {
  at: string;
  importBase?: string;
  entries: readonly Entry[];
  next: { at: string; path: string; after: string } | null;
}
export interface Edit {
  path: string;
  content: string | null;
}
export interface Apply {
  base: string;
  operation: string;
  edits: readonly Edit[];
}
export type Receipt =
  | { state: "landed"; ref: string; oid: string; previous: string; operation: string }
  | {
      state: "conflict";
      ref: string;
      oid: string;
      main: string;
      operation: string;
      conflicts: readonly {
        path: string;
        reason: "content" | "unsupported";
        base: string | null;
        ours: string;
        theirs: string;
        baseBlob: string | null;
        oursBlob: string | null;
        theirsBlob: string | null;
      }[];
    };
export type Conflict = Extract<Receipt, { state: "conflict" }>;
export interface ChangeCursor {
  from: string | null;
  to: string;
  frames: readonly { name: string; after: string }[];
}
export interface RemoteVault {
  initial?: import("./import-types.ts").InitialRemote;
  changes?(input: {
    from: string | null;
    to: string;
    cursor?: ChangeCursor;
    limit?: number;
  }): Promise<{
    from: string | null;
    to: string;
    entries: readonly { path: string; before: string | null; after: string | null }[];
    next: ChangeCursor | null;
  }>;
  list(input?: {
    path?: string;
    at?: string;
    cursor?: NonNullable<Page["next"]>;
    limit?: number;
  }): Promise<Page>;
  read(input: {
    path: string;
    at: string;
    offset?: number;
    maxBytes?: number;
  }): Promise<{ content: string; blob: string; bytes: number; next: number | null } | null>;
  apply(input: Apply): Promise<Receipt>;
  receipt(
    operation: string,
  ): Promise<
    Receipt | { state: "opened" | "saved"; oid: string; ref: string; operation: string } | null
  >;
  resolve(input: {
    ref: string;
    expected: string;
    main: string;
    operation: string;
    edits: readonly Edit[];
  }): Promise<Receipt>;
}
export interface Baseline {
  at: string;
  local: string | null;
  cloud: string | null;
}
export interface Pending {
  request: Apply;
  kind: "apply" | "resolve";
  resolution?: { ref: string; expected: string; main: string };
  sent: Record<string, string | null>;
  before?: Record<string, string | null>;
  attempts: number;
}
export interface SyncState {
  initial?: import("./import-types.ts").InitialState;
  version: 1;
  importId: string;
  head: string | null;
  importBase?: string | null;
  pulledHead?: string | null;
  files: Record<string, Baseline>;
  pending: Pending | null;
  conflicts: Conflict[];
  unsupported: string[];
}
export interface StateStore {
  load(): Promise<SyncState | null>;
  save(state: SyncState): Promise<void>;
}
export interface SyncStatus {
  initial?: { phase: "planning" | "ready"; files: number; bytes: number; confirmed: number };
  state: "idle" | "syncing" | "offline" | "conflict" | "attention";
  queued: number;
  conflicts: number;
  unsupported: readonly string[];
  error: string | null;
  head: string | null;
  importId: string;
}
export const maximumFileBytes = 8 * 1024 * 1024;
export async function blobId(content: string): Promise<string> {
  const body = new TextEncoder().encode(content),
    header = new TextEncoder().encode(`blob ${body.length}\0`),
    value = new Uint8Array(header.length + body.length);
  value.set(header);
  value.set(body, header.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", value))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export const safePath = (path: string) =>
  path.length > 0 &&
  path.length <= 1024 &&
  !path.split("/").some((part) => !part || part === "." || part === ".." || part.startsWith(".")) &&
  ![...path].some((character) => character === "\\" || character.charCodeAt(0) < 32);
