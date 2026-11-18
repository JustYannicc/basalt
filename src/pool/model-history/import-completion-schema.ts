export const historyImportCompletionVersion = "model_request_history_v8_import_completion";
export const historyImportCompletionStatements = [
  `CREATE TABLE IF NOT EXISTS basalt_model_import_completion (
    pool char(16) NOT NULL, source char(64) NOT NULL,
    frozen_from varchar(30) NOT NULL, frozen_to varchar(30) NOT NULL,
    upper_source_id numeric(20,0) NOT NULL CHECK (upper_source_id > 0),
    manifest_digest char(64) NOT NULL, map_digest char(64) NOT NULL,
    ids_digest char(64) NOT NULL, verified_rows bigint NOT NULL CHECK (verified_rows > 0),
    completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pool,source), CHECK (frozen_from <= frozen_to),
    CHECK (pool ~ '^[a-f0-9]{16}$' AND source ~ '^[a-f0-9]{64}$'
      AND manifest_digest ~ '^[a-f0-9]{64}$' AND map_digest ~ '^[a-f0-9]{64}$'
      AND ids_digest ~ '^[a-f0-9]{64}$')
  )`,
];

export const historyImportReconcileVersion = "model_request_history_v12_import_reconcile";
/** Per-range progress of an import-completion reconciliation; safe to drop, never authoritative. */
export const historyImportReconcileStatements = [
  `CREATE TABLE IF NOT EXISTS basalt_model_import_reconcile (
    pool char(16) NOT NULL, source char(64) NOT NULL,
    fence bigint NOT NULL CHECK (fence >= 0), rewrites numeric NOT NULL CHECK (rewrites >= 0),
    range_index smallint NOT NULL CHECK (range_index BETWEEN 0 AND 255),
    bucket char(2), rows bigint NOT NULL CHECK (rows >= 0),
    first_at varchar(30), last_at varchar(30), digest char(64),
    computed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (pool,source,range_index),
    CHECK ((rows = 0) = (bucket IS NULL AND digest IS NULL AND first_at IS NULL AND last_at IS NULL)),
    CHECK (pool ~ '^[a-f0-9]{16}$' AND source ~ '^[a-f0-9]{64}$')
  )`,
];
