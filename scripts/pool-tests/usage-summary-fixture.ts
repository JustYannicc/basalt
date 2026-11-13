import type { OverviewApiPrice } from "../../apps/pool/overview-contract.ts";
import type { SeriesAuthority } from "../../apps/pool/usage-series-contract.ts";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { reference, timestamp, type ModelRequest } from "../../src/pool/model-history/record.ts";
import { homeMetadataFixture } from "./history-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
export const summaryPrices: readonly OverviewApiPrice[] = [0, 1].map((i) => ({
  provider: "fixture-lab",
  model: `fixture-model-${i}`,
  currency: "USD",
  input: "10",
  output: "30",
  cacheRead: "2",
  cacheWrite: "4",
  request: "0",
  tier: "*",
  minInput: "0",
  asOf: "2026-11-04T00:00:00.000Z",
  source: "models.dev",
  version: "fixture-v1",
}));
export const summaryCounters = {
  provider: "fixture-lab",
  model: "fixture-model-0",
  inputTokens: "100",
  outputTokens: "20",
  cacheReadTokens: "0",
  cacheWriteTokens: "0",
  totalTokens: "120",
  tokenQuality: "complete",
  apiType: "responses",
} satisfies Partial<ModelRequest>;

export async function summaryFixture(f: Fixture) {
  await homeMetadataFixture(f.db);
  const source = await digest("home-local-v1");
  const visible = (await reference(source, "account", "fixture-native"))!;
  const hidden = (await reference(source, "account", "fixture-private"))!;
  const fingerprint = `sha256:${"a".repeat(64)}`;
  await f.db.query('INSERT INTO "user" VALUES (7,$1)', [
    await backendUserName("fixture-person-0", pool),
  ]);
  await f.db.query("INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES (9,$1,7)", [
    fingerprint,
  ]);
  await f.db.query("CREATE INDEX fixture_usage_time ON usage(timestamp)");
  await f.db.query("CREATE INDEX fixture_key_fingerprint ON api_key(diagnostic_fingerprint)");
  await f.db.query("CREATE INDEX fixture_charge_usage ON billing_charge(usage_id)");
  await f.db.query('CREATE INDEX fixture_user_id ON "user"(id)');
  const authority: SeriesAuthority = {
    canManage: true,
    mappingProven: true,
    accounts: [
      { account: "saved-native", history: [visible] },
      { account: null, history: [hidden] },
    ],
  };
  const native = async (id: number, at: string, overrides: Partial<ModelRequest> = {}) => {
    await f.insert({
      ...summaryCounters,
      source,
      account: visible,
      timestamp: timestamp(at),
      sourceRecord: await digest(JSON.stringify(["usage", String(id)])),
      ...overrides,
    });
    await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES ($1,$2,$3)", [
      id,
      at,
      fingerprint,
    ]);
  };
  const cursor = async (forward: number) =>
    f.db.query(
      `INSERT INTO basalt_model_history_cursor
    (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,sweep_upper)
    VALUES ($1,$2,$2,$2,true,0,0) ON CONFLICT (source) DO UPDATE
      SET forward_id=excluded.forward_id,backfill_complete=true`,
      [source, forward],
    );
  const analyze = async () => {
    for (const table of ["basalt_model_requests", "usage", "api_key", "billing_charge", '"user"'])
      await f.db.query(`ANALYZE ${table}`);
  };
  return { source, visible, hidden, fingerprint, authority, native, cursor, analyze };
}

/** The reader's synthetic approved receipt, using the completion owner's seven-field contract. */
export async function summaryCompletionFixture(f: Fixture) {
  await f.db.query(`CREATE TABLE basalt_model_import_completion (
    pool char(16),source char(64),frozen_from varchar(30),frozen_to varchar(30),
    upper_source_id numeric(20,0),manifest_digest char(64),map_digest char(64),
    ids_digest char(64),verified_rows bigint,PRIMARY KEY(pool,source))`);
  const source = await digest("fixture-import");
  const completion = {
    frozenFrom: timestamp("2026-01-02T01:45:00Z"),
    frozenTo: timestamp("2026-01-02T01:45:00Z"),
    upperSourceId: "1",
    manifestDigest: "a".repeat(64),
    accountMappingDigest: "b".repeat(64),
    idsDigest: "c".repeat(64),
    verifiedRows: "1",
  };
  for (const [poolId, manifest] of [
    [(await digest(pool)).slice(0, 16), completion.manifestDigest],
    [(await digest("foreign-pool")).slice(0, 16), "d".repeat(64)],
  ])
    await f.db.query(
      `INSERT INTO basalt_model_import_completion
      (pool,source,frozen_from,frozen_to,upper_source_id,manifest_digest,map_digest,ids_digest,verified_rows)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        poolId,
        source,
        completion.frozenFrom,
        completion.frozenTo,
        completion.upperSourceId,
        manifest,
        completion.accountMappingDigest,
        completion.idsDigest,
        completion.verifiedRows,
      ],
    );
  return { source, completion };
}
