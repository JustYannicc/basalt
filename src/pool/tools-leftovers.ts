import type { Registry, StoredComputer } from "./computer-registry.ts";
import { fail, json, object, text } from "./json.ts";
import { revokedByPerson } from "./native-computers.ts";

/** Rows one read returns and one report finishes, so a pass's work never grows with the pool. */
export const toolsLeftoverBatch = 25;

interface Dependencies {
  now: () => number;
  run: <A>(work: (registry: Registry) => Promise<A>) => Promise<A>;
  save: (registry: Registry) => Promise<unknown>;
}

/**
 * A computer set up with a link whose person revoked it, while its tools key may still work. That
 * key is an ordinary tools-service key nothing here can end, so the tools host's every-minute pass
 * deletes it. A row access removal finished, or one restored without history, was never revoked
 * by its person and keeps its key.
 */
export function toolsLeftBehind(row: StoredComputer) {
  if (row.native || row.toolsKeyDeletedAt !== undefined || !revokedByPerson(row)) return false;
  // Only rows the host can read: one it can't would hold back every other row's answer.
  if (!text(row.toolsKeyId) || !text(row.user)) return false;
  // A `removed` row that doesn't say why may be an access removal: it keeps its key until its
  // person revokes it again.
  if (row.state === "removed") return row.removedFor === "revoke";
  return row.state === "revoking" || row.state === "revoked";
}

/**
 * Its tools key is gone. A revoke whose Home keys are confirmed revoked is finished; otherwise
 * upkeep revokes them and finishes it, and access removal finishes a row under removal.
 */
export function toolsKeyDeleted(computer: StoredComputer, at: string) {
  if (computer.toolsKeyId !== undefined) computer.toolsKeyDeletedAt ??= at;
  if (
    computer.state === "revoking" &&
    !computer.removalPending &&
    computer.homeKeysRevokedAt !== undefined
  ) {
    computer.state = "revoked";
    computer.revokedAt ??= at;
  }
}

/**
 * The tools host's two native control actions: read the rows whose tools key it should delete,
 * and report the ones it deleted or found gone. Only the host's own control assertion reaches here.
 */
export function toolsLeftoverControl(value: Record<string, unknown>, deps: Dependencies) {
  if (value.action === "tools-leftovers")
    return deps.run(async (registry) =>
      json({
        computers: Object.values(registry)
          .filter(toolsLeftBehind)
          // Revokes Connect finished before keys were recorded gone wait behind stuck ones.
          .sort(
            (a, b) =>
              Number(a.state === "revoked") - Number(b.state === "revoked") ||
              (a.id < b.id ? -1 : 1),
          )
          .slice(0, toolsLeftoverBatch)
          .map((row) => ({ computer: row.id, user: row.user, toolsKeyId: row.toolsKeyId })),
      }),
    );
  const deleted = value.computers;
  if (
    !Array.isArray(deleted) ||
    deleted.length > toolsLeftoverBatch ||
    !deleted.every((entry) => object(entry) && text(entry.computer) && text(entry.toolsKeyId))
  )
    return fail(400, "invalid_session", "Report at most a batch of deleted tools keys.");
  return deps.run(async (registry) => {
    const at = new Date(deps.now()).toISOString();
    let finished = 0;
    for (const entry of deleted as { computer: string; toolsKeyId: string }[]) {
      const row = Object.hasOwn(registry, entry.computer) ? registry[entry.computer] : undefined;
      // A row whose key changed or that stopped being left behind is not this report's to finish.
      if (!row || row.toolsKeyId !== entry.toolsKeyId || !toolsLeftBehind(row)) continue;
      toolsKeyDeleted(row, at);
      finished++;
    }
    if (finished) await deps.save(registry);
    return json({ finished });
  });
}
