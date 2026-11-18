export type Oid = string;
export type Ref = string;
export type Bytes = Uint8Array<ArrayBuffer>;

export interface Author {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

export interface GitObject {
  oid: Oid;
  type: "blob" | "tree" | "commit" | "tag";
  content: Bytes;
}

export interface ObjectStore {
  get(oid: Oid): Promise<GitObject | null>;
  put(objects: readonly GitObject[]): Promise<void>;
}

export interface Conflict {
  path: string;
  reason: "content" | "unsupported";
  base: Oid | null;
  ours: Oid;
  theirs: Oid;
  baseBlob: Oid | null;
  oursBlob: Oid | null;
  theirsBlob: Oid | null;
}

export type Receipt =
  | { state: "saved"; operation: string; ref: Ref; oid: Oid }
  | { state: "landed"; operation: string; ref: Ref; oid: Oid; previous: Oid }
  | {
      state: "conflict";
      operation: string;
      ref: Ref;
      oid: Oid;
      main: Oid;
      conflicts: readonly Conflict[];
    }
  | { state: "opened"; operation: string; ref: Ref; oid: Oid };

export interface RefChange {
  ref: Ref;
  expected: Oid | null;
  next: Oid;
}

export interface RefTransaction {
  operation: string;
  fingerprint: string;
  changes: readonly RefChange[];
  receipt: Receipt;
}

export type Published =
  | { applied: true; receipt: Receipt }
  | { applied: false; current: Readonly<Record<Ref, Oid | null>> };

export interface RefStore {
  get(ref: Ref): Promise<Oid | null>;
  receipt(operation: string, fingerprint?: string): Promise<Receipt | null>;
  publish(transaction: RefTransaction): Promise<Published>;
}

export interface Edit {
  path: string;
  content: string | Bytes | null;
}

export interface DriveOptions {
  objects: ObjectStore;
  refs: RefStore;
  author: Author;
  maxObjectBytes?: number;
  maxBatchBytes?: number;
}

export interface ListEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  oid: Oid;
}
export interface ListCursor {
  at: Oid;
  path: string;
  after: string;
}
export interface ListPage {
  at: Oid;
  path: string;
  exists: boolean;
  entries: readonly ListEntry[];
  next: ListCursor | null;
}
export interface Drive {
  list(input?: { at?: Oid; path?: string; cursor?: ListCursor; limit?: number }): Promise<ListPage>;
  initialize(operation: string): Promise<Oid>;
  openWriter(input: { id: string; base?: Oid; operation: string }): Promise<{ ref: Ref; oid: Oid }>;
  commit(input: {
    ref: Ref;
    expected: Oid;
    edits: readonly Edit[];
    operation: string;
    message: string;
  }): Promise<Receipt>;
  resolve(input: {
    ref: Ref;
    expected: Oid;
    main: Oid;
    edits: readonly Edit[];
    operation: string;
    message: string;
  }): Promise<Receipt>;
  land(input: { ref: Ref; expected: Oid; operation: string }): Promise<Receipt>;
  read(input: { path: string; at?: Oid }): Promise<{ oid: Oid; blob: Oid; content: Bytes } | null>;
  history(input?: {
    at?: Oid;
    limit?: number;
  }): Promise<readonly { oid: Oid; parents: readonly Oid[]; message: string }[]>;
  receipt(operation: string): Promise<Receipt | null>;
}
