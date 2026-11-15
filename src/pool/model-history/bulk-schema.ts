export const historyBulkSchemaVersion = "model_request_history_v6_bulk_import";
export const historyBulkStatements = [
  `CREATE TABLE IF NOT EXISTS basalt_model_import_jobs (
    id char(64) PRIMARY KEY, pool varchar(256) NOT NULL,
    organization varchar(256) NOT NULL, owner varchar(256) NOT NULL,
    manifest_digest char(64) NOT NULL, map_digest char(64) NOT NULL,
    total_rows bigint NOT NULL CHECK(total_rows > 0),
    total_chunks integer NOT NULL CHECK(total_chunks BETWEEN 1 AND 10000),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS basalt_model_import_receipts (
    job char(64) NOT NULL REFERENCES basalt_model_import_jobs(id),
    chunk integer NOT NULL CHECK(chunk >= 0), start_row integer NOT NULL CHECK(start_row >= 0), input_sha char(64) NOT NULL,
    ids_sha char(64) NOT NULL, rows integer NOT NULL CHECK(rows BETWEEN 1 AND 5000),
    inserted integer NOT NULL CHECK(inserted >= 0), existing integer NOT NULL CHECK(existing >= 0),
    committed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    elapsed_ms integer NOT NULL CHECK(elapsed_ms > 0),
    PRIMARY KEY(job,chunk,start_row), CHECK(inserted + existing = rows)
  )`,
];
