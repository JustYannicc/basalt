/** `2/3` as shard 2 of 3; no argument is the whole index, `1/1`. */
export function parseShard(text = "1/1") {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  const [shard, shards] = match ? [Number(match[1]), Number(match[2])] : [];
  if (!match || shard > shards) throw new Error(`Expected a shard like 2/3, got ${text}`);
  return { shard, shards };
}

/** Every `shards`-th entry from the `shard`-th on, so the shards together take each entry once. */
export const shardEntries = (entries, { shard, shards }) =>
  entries.filter((_entry, position) => position % shards === shard - 1);

/** The packages a full run must read: the official feed lists well over a thousand. */
export const minimumRead = ({ shards }) => Math.floor(1000 / shards);
