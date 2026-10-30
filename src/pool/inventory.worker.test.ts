import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { inventoryCron } from "./inventory.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return {
      url: "data:text/javascript,export class DurableObject {} export class WorkerEntrypoint {}",
      shortCircuit: true,
    };
    if (specifier === "pg") return {
      url: `data:text/javascript,${encodeURIComponent(`
        export const connections = [];
        export default { Client: class {
          constructor(options) { this.url = options.connectionString; connections.push(this.url); }
          on() {}
          async connect() { if (this.url.includes('unavailable')) throw new Error('SYNTHETIC_DATABASE_SECRET'); }
          async query(text) {
            if (text.startsWith('SELECT current_database()')) return {
              rows: [{ database: 'basalt_pool', read_only: 'on', snapshot: '2026-01-01T00:00:00Z' }],
            };
            return { rows: [] };
          }
          async end() {}
        } };
      `)}`,
      shortCircuit: true,
    };
    return next(specifier, context);
  },
});
const workerModule = "./worker.ts";
const { default: worker }: {
  default: { scheduled(event: { cron: string }, env: object): Promise<void> };
} = await import(workerModule);
const pgModule = "pg";
const { connections }: { connections: string[] } = await import(pgModule);
// reportPoolInventory imports pg lazily, so keep the hook until every scheduled call finishes.

test("the exported inventory cron uses only Hyperdrive and reports unavailable bindings privately", async (t) => {
  t.after(() => hooks.deregister());
  const bindingUrl = "postgres://fixture:fixture@hyperdrive.invalid/basalt_pool";
  const cases = [
    { binding: { connectionString: bindingUrl }, connected: true, complete: true },
    { binding: undefined, connected: false, complete: false },
    { binding: { connectionString: "" }, connected: false, complete: false },
    { binding: { connectionString: bindingUrl.replace("hyperdrive", "unavailable") }, connected: true, complete: false },
    { binding: { connectionString: bindingUrl.replace("basalt_pool", "wrong_database") }, connected: false, complete: false },
  ];
  for (const item of cases) {
    const records: string[] = [];
    connections.length = 0;
    let storageInventories = 0;
    const log = t.mock.method(console, "info", (line: string) => records.push(line));
    try {
      await worker.scheduled({ cron: inventoryCron }, {
        POOL_DATABASE_URL: "postgres://SYNTHETIC_DIRECT_SECRET@direct.invalid/basalt_pool?sslmode=verify-full",
        POOL_AUTH_DATABASE: item.binding,
        PoolContainer: {
          jurisdiction(region: string) {
            assert.equal(region, "eu");
            return { getByName(name: string) {
              assert.equal(name, "control-plane");
              return { async migrationInventory() { storageInventories++; } };
            } };
          },
        },
      });
    } finally {
      log.mock.restore();
    }
    assert.deepEqual(connections, item.connected ? [item.binding!.connectionString] : []);
    assert.equal(storageInventories, 1);
    const parsed = records.map((line) => JSON.parse(line));
    const terminal = parsed.filter((record) => record.event === "end");
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].inventory, "pool-v1");
    assert.equal(terminal[0].complete, item.complete);
    assert.equal(terminal[0].migrationGo, false);
    if (item.complete) {
      const report = JSON.parse(parsed.filter((record) => record.event === "part").map((part) => part.data).join(""));
      assert.equal(report.receipt.state, "missing_migration");
      assert.deepEqual(Object.keys(report.sections), ["credentials", "keys", "channels", "memberships"]);
    } else {
      assert.equal(parsed.length, 1);
      assert.equal(terminal[0].reason, "query_failed");
    }
    assert.equal(records.join("").includes("SYNTHETIC"), false);
  }
});
