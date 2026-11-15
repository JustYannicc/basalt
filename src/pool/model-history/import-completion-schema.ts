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
