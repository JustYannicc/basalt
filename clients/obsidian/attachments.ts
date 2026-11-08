/**
 * The plugin UI reads sync state and requests explicit file operations through this port.
 *
 * Model the UI assumes:
 * - Basalt (R2, content-addressed) is the authority for every byte.
 * - "full" devices (desktop) keep every note and attachment locally.
 * - "on-demand" devices (phones) keep every note, fetch a note's attachments when it opens,
 *   and keep pinned folders fully offline.
 */
export type DeviceMode = "full" | "on-demand";

export interface AttachmentSummary {
  /** Local files Basalt does not hold yet. Never counted as synced. */
  unsynced: readonly string[];
  /** Cloud files this device fetches when needed (on-demand devices only). */
  cloudOnly: number;
  /** Downloads in flight, for note-open prefetch or pinned folders. */
  downloading: number;
  /** Files that failed to upload or download, with a person-readable reason. */
  failed: readonly { path: string; reason: string }[];
}

/** One side of a binary conflict, described without pretending to preview it. */
export interface BinaryVersion {
  bytes: number;
  mime: string | null;
  blob: string;
  external?: boolean;
}

/** An explicit choice for one conflicting path. `version` takes that path's bytes from a retained commit. */
export type ConflictChoice =
  | { path: string; kind: "text"; content: string | null }
  | { path: string; kind: "version"; at: string };

export interface AttachmentPort {
  entries?(): readonly { path: string; bytes: number; local: boolean; pinned: boolean }[];
  download?(path: string, signal: AbortSignal): Promise<void>;
  evict?(path: string): Promise<void>;
  mode(): DeviceMode;
  summary(): AttachmentSummary;
  /** Folder paths kept fully offline. Empty on full devices. */
  pins(): readonly string[];
  setPinned(folder: string, pinned: boolean): Promise<void>;
  /** Called when a note opens. Fetches its attachments on on-demand devices. Must honour `signal`. */
  noteOpened(path: string, signal: AbortSignal): Promise<void>;
  /** Size/type of a binary conflict side. Absent until byte sync lands. */
  describeVersion?(path: string, at: string): Promise<BinaryVersion | null>;
  /**
   * Resolves a conflict that includes binary paths. Must accept one choice for every
   * conflicting path in `ref`. Absent until byte sync lands; the UI then keeps such
   * conflicts open instead of guessing.
   */
  resolveMixed?(ref: string, choices: readonly ConflictChoice[]): Promise<void>;
  /** Subscribe to summary/pin changes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/**
 * Text-only stand-in until byte sync is wired: it reports every path the controller could not
 * sync as unsynced, persists pins so the choice survives, and fetches nothing.
 */
export function createInterimAttachments(input: {
  mode: DeviceMode;
  unsupported: () => readonly string[];
  pins: { get(): readonly string[]; set(value: readonly string[]): Promise<void> };
}): AttachmentPort {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    mode: () => input.mode,
    summary: () => ({ unsynced: input.unsupported(), cloudOnly: 0, downloading: 0, failed: [] }),
    pins: () => (input.mode === "on-demand" ? input.pins.get() : []),
    async setPinned(folder, pinned) {
      const current = new Set(input.pins.get());
      if (pinned) current.add(folder);
      else current.delete(folder);
      await input.pins.set([...current].sort());
      notify();
    },
    noteOpened: async () => {},
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
