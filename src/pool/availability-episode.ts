import { Schema } from "effect";

const key = "pool-availability-episode-v1";
/**
 * The failures already reported for one pool: its availability failures as one sorted set of
 * guard:reason, and each failing reliability reason. Detail such as a backend status is not part.
 */
const Episode = Schema.Struct({
  pool: Schema.String,
  availability: Schema.NullOr(Schema.String),
  reliability: Schema.Array(Schema.String),
});
export type AvailabilityEpisode = typeof Episode.Type;
export interface EpisodeReport {
  readonly availability: boolean;
  readonly reliability: readonly string[];
}
interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
}
const isEpisode = Schema.is(Episode);

/**
 * Which of a run's failures start an episode, given those already reported. An availability
 * episode starts when the set differs from the one reported and ends with the first run whose set
 * differs again, a passing run included; a reliability reason's starts when it starts failing and
 * ends with the first run without it. A run whose memory can't be read reports on the quarter hour
 * only: the check-in still carries every minute, and the monitor opens its own incident on it.
 */
export function episodeReport(
  reported: AvailabilityEpisode | undefined | "unreachable",
  next: AvailabilityEpisode,
  now: number,
): EpisodeReport {
  if (reported === "unreachable") {
    const quarter = Math.floor(now / 60_000) % 15 === 0;
    return { availability: quarter, reliability: quarter ? next.reliability : [] };
  }
  const previous = reported?.pool === next.pool ? reported : undefined;
  return {
    availability: next.availability !== null && next.availability !== previous?.availability,
    reliability: next.reliability.filter((reason) => !previous?.reliability.includes(reason)),
  };
}

/** What counts as reported after the run: a start whose events Sentry refused is tried again. */
export function episodeAfter(
  reported: AvailabilityEpisode | undefined,
  next: AvailabilityEpisode,
  report: EpisodeReport,
  delivered: boolean,
): AvailabilityEpisode {
  if (delivered) return next;
  const previous = reported?.pool === next.pool ? reported : undefined;
  return {
    pool: next.pool,
    availability: report.availability ? (previous?.availability ?? null) : next.availability,
    reliability: next.reliability.filter((reason) => !report.reliability.includes(reason)),
  };
}

/** The pool object's own memory of the reported episode, one key in its existing storage. */
export class AvailabilityEpisodes {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
  }
  async read() {
    const value = await this.storage.get(key);
    return isEpisode(value) ? value : undefined;
  }
  async write(episode: AvailabilityEpisode) {
    await this.storage.put(key, episode);
  }
}
