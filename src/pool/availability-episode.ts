import { Schema } from "effect";

const key = "pool-availability-episode-v1";
/** One check's failures: its availability failures as one sorted set, its failing reliability reasons. */
const Signatures = Schema.Struct({
  availability: Schema.NullOr(Schema.String),
  reliability: Schema.Array(Schema.String),
});
export type AvailabilitySignatures = typeof Signatures.Type;
export interface EpisodeReport {
  readonly availability: boolean;
  readonly reliability: readonly string[];
}
interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
}
const isSignatures = Schema.is(Signatures);

/**
 * The per-minute check's failures as episodes. One starts when a check fails in a way the check
 * before it didn't: a new or changed set of availability failures, or a reliability reason not
 * already failing. It ends with the first check without that failure. Only a start is reported as
 * an error event; the check-in still carries every minute, and Sentry opens its own incident on it.
 */
export class AvailabilityEpisodes {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }
  async open(next: AvailabilitySignatures): Promise<EpisodeReport> {
    const value = await this.storage.get(key);
    const previous = isSignatures(value) ? value : { availability: null, reliability: [] };
    await this.storage.put(key, next);
    return {
      availability: next.availability !== null && next.availability !== previous.availability,
      reliability: next.reliability.filter((reason) => !previous.reliability.includes(reason)),
    };
  }
}
