import type { MutationContext, SqlTransaction } from "apps";
import { requirements } from "./installation.ts";
import { controls } from "./state.ts";

export function rememberScan(
  tx: SqlTransaction,
  workflow: string,
  key: string,
  successful: boolean,
) {
  const now = Date.now();
  tx.exec(
    "INSERT INTO scans (workflow, key, checked_at, successful_at) VALUES (?, ?, ?, ?) ON CONFLICT(workflow, key) DO UPDATE SET checked_at = excluded.checked_at, successful_at = CASE WHEN ? THEN excluded.successful_at ELSE scans.successful_at END",
    workflow,
    key,
    now,
    successful ? now : 0,
    successful ? 1 : 0,
  );
}
/** Inventory changes retire removed resources; an empty authorized inventory is a completed scan. */
export function retainScans(
  ctx: MutationContext<typeof requirements>,
  workflow: string,
  keys: string[],
) {
  controls(ctx);
  ctx.sql.transaction((tx) => {
    tx.exec(
      `DELETE FROM scans WHERE workflow = ? AND key NOT IN (${keys.map(() => "?").join(",") || "?"})`,
      workflow,
      ...(keys.length ? keys : [""]),
    );
    if (!keys.length) rememberScan(tx, workflow, "", true);
  });
}
