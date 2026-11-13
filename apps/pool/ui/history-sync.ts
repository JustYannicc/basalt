import { ChangeReadRetry, type ChangeFeed, type ChangeWatch } from "apps/client";

/** Who may see which requests and totals. */
export const authorityTopics = ["apps", "membership", "session"];
/** History reads fence on authority heads as well as usage, samples and prices. */
const topics = [...authorityTopics, "pool-usage", "pool-samples", "pool-prices"];

export interface HistorySync {
  /** Bumped by every authority change; a page or read begun under an older one is dropped. */
  readonly generation: () => number;
  /** Fences next-page reads on authority without claiming the shown snapshot's usage heads. */
  readonly pages: ChangeWatch;
  /** Read again, keeping what is shown (a person's retry). */
  readonly request: () => void;
  readonly stop: () => void;
}

/**
 * Keeps one history read in step with the change feed. The main watch reads on every topic, so
 * its own fence rejects a body whose authority heads moved while it ran. An authority hint
 * synchronously starts a new generation, owes a reset and clears what is shown; the main watch
 * reads for that same hint, so there is no extra read. A body is published only when its data
 * work began in the current generation; one begun earlier is never published and is read again.
 * The owed reset is cleared only by such an accepted body, never by a rejected read.
 */
export function syncHistory<T>(
  feed: ChangeFeed,
  options: {
    readonly read: () => Promise<T>;
    /** An accepted body of the current generation; `reset` replaces every page and total. */
    readonly apply: (value: T, reset: boolean) => void;
    /** Authority changed: drop all protected history now, before any replacement arrives. */
    readonly clear: () => void;
    /** A read was not accepted. With a reset owed, nothing from the old grant may be kept. */
    readonly rejected: (error: ChangeReadRetry, resetOwed: boolean) => void;
    /** Whether a change-driven read is in flight. */
    readonly reading: (active: boolean) => void;
    readonly revoked: () => void;
  },
): HistorySync {
  let generation = 0;
  let resetOwed = false;
  let primed = false;
  const main = feed.watch({
    topics,
    refresh: async () => {
      let owned = generation;
      let value: T;
      options.reading(true);
      try {
        value = await main.read(async () => {
          owned = generation;
          return options.read();
        });
      } catch (error) {
        options.reading(false);
        if (error instanceof ChangeReadRetry && error.reason !== "hidden")
          options.rejected(error, resetOwed);
        return;
      }
      options.reading(false);
      // Its data work began before an authority change: never published, read again.
      if (owned !== generation) {
        main.request();
        return;
      }
      const reset = resetOwed;
      resetOwed = false;
      options.apply(value, reset);
    },
    revoked: options.revoked,
  });
  const authority = feed.watch({
    topics: authorityTopics,
    refresh: async () => {
      // The first refresh only records the authority heads the first read loads under.
      if (primed) {
        generation++;
        resetOwed = true;
        options.clear();
      }
      primed = true;
      // Data-free: records authority heads, so a reconnect at the same heads reads nothing.
      await authority.read(async () => undefined).catch(() => undefined);
    },
    revoked: () => undefined,
  });
  const pages = feed.watch({
    topics: authorityTopics,
    refresh: () => undefined,
    revoked: () => undefined,
  });
  return {
    generation: () => generation,
    pages,
    request: () => main.request(),
    stop: () => {
      main.stop();
      authority.stop();
      pages.stop();
    },
  };
}
