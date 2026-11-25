import { createHash } from "node:crypto";

export type Shard = { shard: number; shards: number };

/** `2/3` as shard 2 of 3; no argument is the whole index, `1/1`. */
export function parseShard(text = "1/1"): Shard {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  const shard = Number(match?.[1]);
  const shards = Number(match?.[2]);
  if (!match || shard > shards) throw new Error(`Expected a shard like 2/3, got ${text}`);
  return { shard, shards };
}

/**
 * The entries whose id hashes to this shard. Each leg fetches the live index on its own, so a
 * package added or removed between two legs' fetches must not shift any other package to another
 * shard, as splitting by position would.
 */
export const shardEntries = <Entry extends { id: string }>(
  entries: readonly Entry[],
  { shard, shards }: Shard,
) =>
  entries.filter(
    (entry) =>
      createHash("sha256").update(entry.id).digest().readUInt32BE(0) % shards === shard - 1,
  );

/** The ids, such as test file paths, that hash to this shard: each lands in exactly one. */
export const shardIds = (ids: readonly string[], shard: Shard) =>
  shardEntries(
    ids.map((id) => ({ id })),
    shard,
  ).map(({ id }) => id);

/** The packages a full shard must read: the official feed lists well over a thousand, and hashing
 * splits it unevenly, so each of n shards must read at least a thousand divided by n. */
export const minimumRead = ({ shards }: Pick<Shard, "shards">) => Math.floor(1000 / shards);
