import { Schema } from "effect";

export { importRemovalPath, importRemovalName, importRemovalRevision } from "./paths.ts";

const Credential = Schema.Struct({ id: Schema.String, provider: Schema.String });
export const Selection = Schema.Struct({
  organization: Schema.String,
  pool: Schema.String,
  remove: Schema.Array(Credential),
  retain: Credential,
});
export type RemovalSelection = typeof Selection.Type;

export class RemovalRefused extends Error {
  readonly status: number;
  constructor(status = 409) {
    super("Pool import removal refused");
    this.status = status;
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Signed requests supply the reviewed IDs. Neither labels nor provider searches select rows. */
export function removalSelection(value: unknown): RemovalSelection {
  const selection = Schema.decodeUnknownSync(Selection)(value);
  const credentials = [...selection.remove, selection.retain];
  if (
    !selection.organization ||
    selection.organization.length > 256 ||
    !selection.pool ||
    selection.pool.length > 256 ||
    selection.remove.length !== 4 ||
    credentials.some((row) => !uuid.test(row.id) || !/^[a-z0-9-]{1,64}$/.test(row.provider)) ||
    new Set(credentials.map((row) => row.id)).size !== credentials.length
  )
    throw new RemovalRefused(400);
  return { ...selection, remove: [...selection.remove].sort((a, b) => a.id.localeCompare(b.id)) };
}

export const RemovalPlan = Schema.Struct({
  format: Schema.Literal("basalt-home-import-removal-v1"),
  selection: Selection,
  revision: Schema.String,
  target: Schema.String,
  release: Schema.String,
  database: Schema.String,
  observedAt: Schema.Number,
  expiresAt: Schema.Number,
  snapshotSha256: Schema.String,
  backupSha256: Schema.String,
});
export type RemovalPlan = typeof RemovalPlan.Type;
