import { Schema } from "effect";
import { ControllerCode, SlotRefused } from "./runtime-slots/contract.ts";
import { runtimeInput } from "./runtime-slots/input.ts";
import type { TransactionStorage } from "./runtime-slots/storage.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u));
const Time = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
// Bookmarks are opaque. Only printable ASCII keeps the documented lexical order meaningful.
const Bookmark = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,256}$/u));
const Instant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u),
);
const fields = { controllerCode: ControllerCode, at: Time, expiresAt: Time };

export const StorageBookmarkCommand = Schema.Struct({
  ...fields,
  action: Schema.Literal("storage-bookmark"),
  time: Schema.optional(Instant),
});
export const StorageRestoreCommand = Schema.Struct({
  ...fields,
  action: Schema.Literal("storage-restore-bookmark"),
  target: Bookmark,
  expectedCurrent: Bookmark,
  nonce: Name,
  operator: Name,
});
export type StorageRestoreCommand = typeof StorageRestoreCommand.Type;

export const storageRestoreNonceKey = (nonce: string) => `storage-restore-v1:command:${nonce}`;
/** The platform keeps point-in-time recovery for 30 days. */
export const bookmarkRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const issuedLimit = 32;

export function currentRestoreCommand(value: unknown, now = Date.now()) {
  const command = runtimeInput(() =>
    Schema.decodeUnknownSync(StorageRestoreCommand, { onExcessProperty: "error" })(value),
  );
  if (
    command.at > now + 5_000 ||
    command.expiresAt <= now ||
    command.expiresAt <= command.at ||
    command.expiresAt > command.at + 30_000
  )
    throw new SlotRefused("identity");
  return command;
}

/** The storage calls exist only on a deployed SQLite-backed object, so they stay behind this port. */
export interface BookmarkPort {
  current(): Promise<string>;
  forTime(at: number): Promise<string>;
  /** Schedules the restore for the next session and returns the bookmark that undoes it. */
  restoreOnNextSession(bookmark: string): Promise<string>;
  /** Ends this session, which applies the scheduled restore. */
  abort(): void;
}
interface Dependencies {
  storage: TransactionStorage;
  port: BookmarkPort;
  /** Runs once the reply has been handed to the platform. */
  afterReply(work: () => void): void;
  now?: () => number;
}

/**
 * A restore rolls back the stored nonce with everything else, so the nonce only stops a replay
 * while this session lives. The session itself is the second fence: a restore is accepted only
 * against a current bookmark this session handed out, and every restore ends the session.
 */
export class StorageBookmarks {
  private deps: Dependencies;
  private issued = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  async read(time?: string) {
    const now = this.now();
    if (time === undefined) {
      const bookmark = await this.deps.port.current();
      this.issued.delete(bookmark);
      this.issued.add(bookmark);
      for (const oldest of this.issued) {
        if (this.issued.size <= issuedLimit) break;
        this.issued.delete(oldest);
      }
      return { bookmark, at: new Date(now).toISOString() };
    }
    const at = Date.parse(time);
    if (!Number.isFinite(at) || at > now || at < now - bookmarkRetentionMs)
      throw new SlotRefused("selection");
    return { bookmark: await this.deps.port.forTime(at), at: new Date(at).toISOString() };
  }
  restore(value: StorageRestoreCommand) {
    const pending = this.queue.then(() => this.apply(value));
    this.queue = pending.catch(() => {});
    return pending;
  }
  private async apply(value: StorageRestoreCommand) {
    const { storage, port } = this.deps;
    const command = currentRestoreCommand(value, this.now());
    const key = storageRestoreNonceKey(command.nonce);
    if (await storage.get(key)) throw new SlotRefused("selection");
    if (!this.issued.has(command.expectedCurrent)) throw new SlotRefused("identity");
    const live = await port.current();
    if (command.target >= command.expectedCurrent || command.expectedCurrent > live)
      throw new SlotRefused("identity");
    await storage.transaction(async (transaction) => {
      currentRestoreCommand(command, this.now());
      if (await transaction.get(key)) throw new SlotRefused("selection");
      await transaction.put(key, { command, live, at: this.now(), status: "submitted" });
    });
    const undo = await port.restoreOnNextSession(command.target);
    this.issued.clear();
    // The restore discards the stored record, so this line is the audit that survives it.
    console.info(
      "POOL_STORAGE_RESTORE",
      JSON.stringify({
        nonce: command.nonce,
        operator: command.operator,
        target: command.target,
        expectedCurrent: command.expectedCurrent,
        live,
        undo,
      }),
    );
    this.deps.afterReply(() => port.abort());
    return { target: command.target, live, undo };
  }
}
