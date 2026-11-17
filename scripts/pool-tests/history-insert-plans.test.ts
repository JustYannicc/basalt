import assert from "node:assert/strict";
import { test } from "node:test";
import { historyInsertFixture } from "./history-insert-fixture.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { digest } from "../../src/pool/backend-users.ts";

test("history hash resolution preserves targets and uses covering indexes instead of full scans", async () => {
  await historyInsertFixture(async ({ a }) => {
    await a.query(`ALTER TABLE channel_group DISABLE TRIGGER basalt_pool_change_write;
      INSERT INTO channel_group SELECT 10000+i,'signalbox-pool-app_dataset_'||lpad(i::text,5,'0'),false,NULL FROM generate_series(1,10000) AS i;
      ALTER TABLE channel_group ENABLE TRIGGER basalt_pool_change_write;
      INSERT INTO basalt_pool_change_heads SELECT 'app_dataset_'||lpad(i::text,5,'0'),t.topic,0
        FROM generate_series(1,10000) AS i CROSS JOIN (VALUES('pool-readings'),('pool-usage')) AS t(topic);
      ANALYZE channel_group; ANALYZE basalt_pool_change_heads`);
    const hash = (await digest("app_dataset_05000")).slice(0, 16);
    await a.query(
      "RESET ROLE; LOAD 'auto_explain'; SET auto_explain.log_nested_statements=on; SET auto_explain.log_analyze=on; SET auto_explain.log_buffers=on; SET auto_explain.log_format=json; SET client_min_messages=log; SET ROLE basalt_pool_owner",
    );
    const plans: Record<string, unknown>[] = [];
    a.on("notice", (notice) => {
      if (notice.message?.includes('"Query Text"'))
        plans.push(JSON.parse(notice.message.slice(notice.message.indexOf("{"))).Plan);
    });
    const resolve = async () => {
      plans.length = 0;
      await a.query("RESET ROLE; SET auto_explain.log_min_duration=0; SET ROLE basalt_pool_owner");
      try {
        const result = await a.query(
          "SELECT * FROM basalt_pool_change_targets('{}','{}',$1) ORDER BY pool",
          [[hash]],
        );
        return { rows: result.rows, plans: [...plans] };
      } finally {
        await a.query(
          "RESET ROLE; SET auto_explain.log_min_duration=-1; SET ROLE basalt_pool_owner",
        );
      }
    };
    const before = await resolve();
    await migrateModelHistory(a);
    await a.query("VACUUM(ANALYZE) channel_group");
    await a.query("VACUUM(ANALYZE) basalt_pool_change_heads");
    await resolve();
    const after = await resolve();
    assert.deepEqual(after.rows, before.rows);
    const scans = (plan: Record<string, unknown>): Record<string, unknown>[] => [
      plan,
      ...((plan.Plans ?? []) as Record<string, unknown>[]).flatMap(scans),
    ];
    const oldScans = before.plans
      .flatMap(scans)
      .filter((node) =>
        ["channel_group", "basalt_pool_change_heads"].includes(String(node["Relation Name"])),
      );
    const newScans = after.plans
      .flatMap(scans)
      .filter((node) =>
        ["channel_group", "basalt_pool_change_heads"].includes(String(node["Relation Name"])),
      );
    assert.deepEqual(
      oldScans.map((node) => node["Node Type"]),
      ["Seq Scan", "Seq Scan"],
    );
    assert.deepEqual(
      newScans.map((node) => node["Node Type"]),
      ["Index Only Scan", "Index Only Scan"],
    );
    assert.ok(newScans.every((node) => node["Heap Fetches"] === 0));
    const hits = (nodes: Record<string, unknown>[]) =>
      nodes.reduce((sum, node) => sum + Number(node["Shared Hit Blocks"]), 0);
    assert.ok(hits(newScans) < hits(oldScans) / 10);
    console.log(
      JSON.stringify({
        rows: { groups: 10002, heads: 20003 },
        before: oldScans,
        after: newScans,
        bufferHits: [hits(oldScans), hits(newScans)],
      }),
    );
    for (const value of [
      "app_dataset_05000",
      "app_é日本🚀",
      "app_",
      "app_\\escaped",
      "app_\nnewline",
    ]) {
      assert.equal(
        (
          await a.query(
            "SELECT basalt_pool_history_hash($1)=left(encode(sha256(convert_to($1,'UTF8')),'hex'),16) AS same",
            [value],
          )
        ).rows[0]!.same,
        true,
      );
    }
  });
});
