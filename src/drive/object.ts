import { Effect, Schema } from "effect";
import { DriveCommand, DriveRequestFailed } from "apps/contracts";
import type { DriveCommand as Command } from "apps/contracts";
import { createDriveDispatcher } from "./dispatch.ts";
import { openVault } from "./vault.ts";
import { createGitRemote } from "./artifacts/transport.ts";
import type { VaultRepository } from "./artifacts/stores.ts";
import type { Bucket, TransactionStorage } from "./shared/index.ts";

/** The slice of the Artifacts Workers binding a vault uses. */
export interface ArtifactsNamespace {
  create(name: string, options?: { setDefaultBranch?: string }): Promise<{ remote: string }>;
  get(name: string): Promise<ArtifactsRepo>;
}
export interface ArtifactsRepo {
  info(): Promise<{ remote: string }>;
  createToken(
    scope: "write",
    ttlSeconds: number,
  ): Promise<{ plaintext: string; expiresAt: string }>;
  readBlob(oid: string): Promise<Blob | null>;
  [Symbol.dispose]?(): void;
}

/** The slice of an R2 bucket binding a vault uses. Reads are ranged parts of at most 1 MiB. */
export interface VaultBucket {
  put(key: string, value: Uint8Array | string): Promise<unknown>;
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(options: {
    prefix: string;
    cursor?: string;
    startAfter?: string;
    limit: number;
  }): Promise<{ objects: readonly { key: string }[]; truncated: boolean; cursor?: string }>;
  delete(key: string): Promise<unknown>;
}

/** Strata's bucket, over the runtime binding: bodies are rebuilt from the bounded ranged read. */
const strataBucket = (bucket: VaultBucket): Bucket & { delete(key: string): Promise<unknown> } => ({
  put: (key, value) => bucket.put(key, value),
  async get(key, options) {
    const object = await bucket.get(key, options);
    if (!object) return null;
    const bytes = await object.arrayBuffer();
    return {
      size: object.size,
      body: new Blob([bytes]).stream(),
      arrayBuffer: async () => bytes,
    };
  },
  list: (options) => bucket.list(options),
  delete: (key) => bucket.delete(key),
});

/** What crosses the object's RPC boundary: plain JSON, success or the drive's typed failure. */
export type VaultReply =
  | { ok: true; value: unknown }
  | { ok: false; error: typeof DriveRequestFailed.Encoded };

/** Expected drive failures are replies; anything else is a defect and propagates as one. */
export const reply = (result: Effect.Effect<unknown, DriveRequestFailed>): Promise<VaultReply> =>
  Effect.runPromise(
    result.pipe(
      Effect.map((value): VaultReply => ({ ok: true, value })),
      Effect.catchTag("DriveRequestFailed", (error) =>
        Effect.succeed<VaultReply>({
          ok: false,
          error: Schema.encodeSync(DriveRequestFailed)(error),
        }),
      ),
    ),
  );

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
/** The grant id in the host's MCP caller, `[userId, clientId, organization, grantId]`. */
export const grantOf = (caller: string | undefined) => {
  if (caller === undefined) return null;
  try {
    const parts: unknown = JSON.parse(caller);
    return Array.isArray(parts) && typeof parts[3] === "string" && parts[3] ? parts[3] : null;
  } catch {
    return null;
  }
};
/**
 * The main a device's sync call has seen. Only the shapes of the plugin's sync calls count: its
 * heartbeat (a one-entry listing of the root, at the start of every pull and checkpoint), its change
 * ranges and its import calls. A landed write counts at the heartbeat that follows it. The vault sees
 * only the grant id, not what kind of client holds it, so an agent's ordinary listings, reads and
 * writes record nothing, but an agent making one of these exact calls is recorded like a device.
 */
export const seenHead = (command: Command, value: unknown): string | null => {
  const out = record(value);
  const head = (method: unknown) => {
    if (method === "list") return typeof out.at === "string" ? out.at : null;
    if (method === "changes") return typeof out.to === "string" ? out.to : null;
    if (method === "apply" && out.state === "landed" && typeof out.oid === "string") return out.oid;
    return null;
  };
  if (command.method === "runImport") return head(record(record(command.input).request).method);
  if (command.method === "changes") return head("changes");
  if (command.method !== "list") return null;
  const input = record(command.input);
  const heartbeat =
    input.limit === 1 &&
    input.path === undefined &&
    input.at === undefined &&
    input.cursor === undefined;
  return heartbeat ? head("list") : null;
};
const tokenSeconds = 3600,
  refreshMs = 5 * 60_000;
const repositoryName = (app: string) => {
  const name = `vault-${app}`.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) throw new Error("Invalid vault repository name");
  return name;
};
const close = (repo: ArtifactsRepo) => repo[Symbol.dispose]?.();

/**
 * One vault object per app: its storage, its attachment bucket and its Artifacts repository. The
 * write token lives only in this object's memory, is never stored and is never returned.
 */
export function vaultObject(
  input: {
    app: string;
    storage: TransactionStorage;
    bucket: VaultBucket;
    artifacts: ArtifactsNamespace;
    now?: () => number;
  },
  /** Internal test seam for defects raised by a dispatcher after the vault opens. */
  dispatcherFactory: typeof createDriveDispatcher = createDriveDispatcher,
) {
  const now = input.now ?? Date.now,
    name = repositoryName(input.app);
  let opened: ReturnType<typeof open> | undefined;
  let token: { plaintext: string; expiresAt: number } | undefined;

  const repository = async () => {
    try {
      const created = await input.artifacts.create(name, { setDefaultBranch: "main" });
      return created.remote;
    } catch (error) {
      // An existing repository is the normal case after the first request.
      const repo = await input.artifacts.get(name).catch(() => {
        throw error;
      });
      try {
        return (await repo.info()).remote;
      } finally {
        close(repo);
      }
    }
  };
  const auth = async () => {
    if (!token || token.expiresAt - refreshMs <= now()) {
      const repo = await input.artifacts.get(name);
      try {
        const minted = await repo.createToken("write", tokenSeconds);
        token = { plaintext: minted.plaintext, expiresAt: Date.parse(minted.expiresAt) };
      } finally {
        close(repo);
      }
    }
    return token.plaintext;
  };
  const open = async () => {
    const remote = createGitRemote({ url: await repository(), auth });
    const vaultRepository: VaultRepository = {
      refs: () => remote.refs(),
      push: (request) => remote.push(request),
      fetchObjects: (request) => remote.fetchObjects(request),
      async readBlob(oid) {
        const repo = await input.artifacts.get(name);
        try {
          const blob = await repo.readBlob(oid);
          return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
        } finally {
          close(repo);
        }
      },
    };
    const vault = await openVault({
      storage: input.storage,
      accountStorage: input.storage,
      bucket: strataBucket(input.bucket),
      prefix: `${name}/`,
      repository: vaultRepository,
      now,
    });
    return dispatcherFactory(
      vault.drive,
      vault.attachments,
      vault.changes,
      vault.root,
      vault.imports,
      {
        ...vault.notes,
        devices: () => devices(vault.notes),
      },
    );
  };
  const ready = async () => {
    opened ??= open();
    try {
      return await opened;
    } catch {
      // A failed open (the repository was unreachable) must not stick for the object's lifetime.
      opened = undefined;
      return null;
    }
  };
  const { sql } = input.storage;
  // Each device's last successful sync, keyed by its grant: what the vault page shows as up to date.
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_devices (agent TEXT PRIMARY KEY, last_sync_at INTEGER NOT NULL, last_head TEXT NOT NULL)",
  );
  const stamp = (caller: string | undefined, command: Command, value: unknown) => {
    const agent = grantOf(caller),
      head = seenHead(command, value);
    if (!agent || !head) return;
    sql.exec(
      "INSERT INTO vault_devices(agent, last_sync_at, last_head) VALUES (?, ?, ?) ON CONFLICT(agent) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_head = excluded.last_head",
      agent,
      now(),
      head,
    );
  };
  const unavailable: VaultReply = {
    ok: false,
    error: { _tag: "DriveRequestFailed", reason: "unavailable" },
  };

  /** The current head, when it changed, and each device's last sync and the head it had then. */
  const devices = async (notes: {
    head(): Promise<string | null>;
    lastChange(): Promise<string | null>;
  }) => ({
    head: await notes.head(),
    lastChangeAt: await notes.lastChange(),
    devices: [
      ...sql.exec(
        "SELECT agent, last_sync_at, last_head FROM vault_devices ORDER BY last_sync_at DESC",
      ),
    ].map((row) => ({
      agent: String(row.agent),
      lastSyncAt: new Date(Number(row.last_sync_at)).toISOString(),
      lastHead: String(row.last_head),
    })),
  });

  return {
    /** `caller` is the host's authenticated MCP caller; a sync from a device grant is recorded. */
    async request(command: unknown, caller?: string): Promise<VaultReply> {
      let decoded: Command;
      try {
        decoded = Schema.decodeUnknownSync(DriveCommand)(command);
      } catch {
        return { ok: false, error: { _tag: "DriveRequestFailed", reason: "invalid_request" } };
      }
      const dispatch = await ready();
      if (!dispatch) return unavailable;
      const answer = await reply(dispatch(decoded));
      if (answer.ok) stamp(caller, decoded, answer.value);
      return answer;
    },
  };
}
