export type HistoryOperatorField =
  | `operator.${"connect" | "request" | "response.status" | "response.json" | "invoke"}`
  | `report.${
      | "version"
      | "schemaHash"
      | "catalogHash"
      | "applied"
      | "status"
      | "writes"
      | "automaticBackfill"
      | "readersReadyRequired"
      | "catalog"
      | "catalog.relations"
      | "catalog.journalActivated"
      | "catalog.journalPrepared"
      | "catalogDiff"
      | "catalogDiff.createTables"
      | "catalogDiff.conflicts"
      | "pendingMigrations"}`;

/** Provider messages and response bodies stay private; only closed fields cross the release boundary. */
export class HistoryOperatorFailure extends Error {
  readonly field: HistoryOperatorField;
  readonly status: number | undefined;

  constructor(field: HistoryOperatorField, status?: number, cause?: unknown) {
    super(`Pool history operator failed at ${field}`, { cause });
    this.field = field;
    this.status = status;
  }
}

export async function historyOperatorStep<A>(
  field: HistoryOperatorField,
  action: () => Promise<A>,
): Promise<A> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HistoryOperatorFailure) throw error;
    throw new HistoryOperatorFailure(field, undefined, error);
  }
}
