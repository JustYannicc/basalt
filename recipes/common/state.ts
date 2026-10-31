import type { MutationContext, QueryContext, SqlTransaction } from "apps";
import { requirements } from "./installation.ts";
import { emptyCheckpoint, type Checkpoint } from "./types.ts";
type Reader = QueryContext<typeof requirements> | MutationContext<typeof requirements>;
type Writer = MutationContext<typeof requirements>;
export function controls(ctx: Reader) {
  const row = ctx.sql
    .exec<{ owner: string | null; configuration_revision: string; delivery_enabled: number }>(
      "SELECT owner, configuration_revision, delivery_enabled FROM controls WHERE id = 1",
    )
    .one();
  if (row.owner === null || row.owner !== ctx.user.id)
    throw new Error("Configure an unshared private copy as its owner first.");
  return row;
}
export function read(ctx: Reader, key: string): Checkpoint {
  const row = ctx.sql
    .exec<{ state: string }>("SELECT state FROM checkpoints WHERE key = ?", key)
    .toArray()[0];
  return row === undefined ? emptyCheckpoint() : JSON.parse(row.state);
}
export function write(
  ctx: Writer,
  key: string,
  update: (current: Checkpoint, tx: SqlTransaction) => Checkpoint,
) {
  controls(ctx);
  return ctx.sql.transaction((tx) => {
    const row = tx
      .exec<{ state: string }>("SELECT state FROM checkpoints WHERE key = ?", key)
      .toArray()[0];
    const before: Checkpoint = row === undefined ? emptyCheckpoint() : JSON.parse(row.state);
    const after = update(before, tx);
    tx.exec(
      "INSERT INTO checkpoints (key, revision, state) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, state = excluded.state",
      key,
      after.revision,
      JSON.stringify(after),
    );
    return after;
  });
}
