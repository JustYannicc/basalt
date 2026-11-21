# Legacy release-layer reads

The one-time cutover check reads the old release layer's `basalt-sql-schema-barrier` journal through `readSqlSchemaJournal`, to confirm `unresolvedHome` is null before the first native release. Nothing else uses this folder. Delete it once the cutover has run.
