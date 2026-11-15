export const historyJournalPrepareVersion = "model_request_history_v9_change_journal_prepare";
export const historyJournalActivateVersion = "model_request_history_v10_change_journal_activate";

/** Reader preparation must not switch the producer while an older Worker can still read it. */
export const historyJournalPrepareStatements = [
  `CREATE TABLE basalt_pool_change_batches (transaction_id bigint PRIMARY KEY)`,
  `CREATE TABLE basalt_pool_change_dirty (
    transaction_id bigint NOT NULL,pool varchar(256) NOT NULL,
    topic text NOT NULL CHECK (topic IN ('pool-readings','pool-usage')),
    PRIMARY KEY(transaction_id,pool,topic))`,
  `CREATE INDEX basalt_pool_change_dirty_key ON basalt_pool_change_dirty(pool,topic)`,
  `CREATE FUNCTION basalt_pool_change_revision(pool_id text,change_topic text) RETURNS bigint
    LANGUAGE sql STABLE AS $$
    SELECT COALESCE(h.revision,0)+q.pending
      FROM (SELECT count(*) AS pending FROM basalt_pool_change_dirty WHERE pool=$1 AND topic=$2) q
      LEFT JOIN basalt_pool_change_heads h ON h.pool=$1 AND h.topic=$2
    $$`,
  `CREATE FUNCTION basalt_pool_project_changes(batch_limit integer) RETURNS integer
    LANGUAGE plpgsql AS $$
    DECLARE batches bigint[]; item record; accepted bigint;
    BEGIN
      IF batch_limit < 1 OR batch_limit > 100 THEN
        RAISE EXCEPTION 'Change projection batch must be between 1 and 100' USING ERRCODE='22023';
      END IF;
      SELECT array_agg(transaction_id) INTO batches FROM (
        SELECT transaction_id FROM basalt_pool_change_batches ORDER BY transaction_id
          LIMIT batch_limit FOR UPDATE SKIP LOCKED
      ) claimed;
      IF batches IS NULL THEN RETURN 0; END IF;
      FOR item IN SELECT pool,topic,count(*) AS revisions FROM basalt_pool_change_dirty
        WHERE transaction_id=ANY(batches) GROUP BY pool,topic
        ORDER BY pool COLLATE "C",topic COLLATE "C" LOOP
        INSERT INTO basalt_pool_change_heads AS h(pool,topic,revision)
          VALUES(item.pool,item.topic,item.revisions)
          ON CONFLICT(pool,topic) DO UPDATE SET revision=h.revision+EXCLUDED.revision
          RETURNING revision INTO accepted;
        INSERT INTO basalt_pool_change_pending AS p(pool,topic,revision)
          VALUES(item.pool,item.topic,accepted)
          ON CONFLICT(pool,topic) DO UPDATE
            SET revision=GREATEST(p.revision,EXCLUDED.revision),queued_at=now();
      END LOOP;
      DELETE FROM basalt_pool_change_dirty WHERE transaction_id=ANY(batches);
      DELETE FROM basalt_pool_change_batches WHERE transaction_id=ANY(batches);
      RETURN cardinality(batches);
    END $$`,
];

/** Kept out of normal schema apply. Activation follows the operator's reader-ready cutover. */
export const historyJournalActivateStatements = [
  `CREATE OR REPLACE FUNCTION basalt_pool_change(pool_id text,change_topic text) RETURNS void
    LANGUAGE plpgsql AS $$ DECLARE own_transaction bigint := txid_current(); BEGIN
      IF pool_id IS NULL OR pool_id !~ '^app_.{1,252}$' THEN RETURN; END IF;
      INSERT INTO basalt_pool_change_dirty(transaction_id,pool,topic)
        VALUES(own_transaction,pool_id,change_topic) ON CONFLICT DO NOTHING;
      INSERT INTO basalt_pool_change_batches VALUES(own_transaction) ON CONFLICT DO NOTHING;
    END $$`,
  `CREATE FUNCTION basalt_pool_flush_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM pg_notify('basalt_pool_committed_changes','');
    RETURN NULL;
  END $$`,
  `CREATE CONSTRAINT TRIGGER basalt_pool_flush_changes AFTER INSERT ON basalt_pool_change_batches
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION basalt_pool_flush_changes()`,
];
