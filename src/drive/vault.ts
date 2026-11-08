import { vaultAttachments } from "./attachment-service.ts";
import {
  createDrive,
  createChangeReader,
  openCloudflareStorage,
  type Drive,
  type Bucket,
  type TransactionStorage,
  type RefStore,
} from "./shared/index.ts";
import { createDriveService } from "./service.ts";
import { quotaAccount } from "./quota.ts";
import { effectiveLimits, type QuotaLimits } from "./quota-limits.ts";
import { meteredBucket } from "./io-quota.ts";
import { treeUsage } from "./tree-usage.ts";
import { cacheObjects } from "./object-cache.ts";
import { importManifest } from "./import-manifest.ts";
import { importService } from "./import-service.ts";
import { operationScope } from "./operation-scope.ts";
import type { ImportPolicy } from "./import-budget.ts";

export async function openVault(input: {
  storage: TransactionStorage;
  accountStorage: TransactionStorage;
  bucket: Bucket & { delete?(key: string): Promise<unknown> };
  prefix: string;
  limits?: Partial<QuotaLimits>;
  cacheBytes?: number;
  now?: () => number;
  importPolicy?: Partial<ImportPolicy>;
}) {
  const limits = effectiveLimits(input.limits),
    quota = quotaAccount(input.accountStorage, limits),
    now = input.now ?? Date.now;
  const io = meteredBucket({
    storage: input.accountStorage,
    bucket: input.bucket,
    limits,
    now,
    prefix: input.prefix,
    ...(input.importPolicy ? { importPolicy: input.importPolicy } : {}),
  });
  const manifest = importManifest(input.accountStorage, input.prefix, limits, io.imports);
  return io.run(async () => {
    const attachments = vaultAttachments({
      bucket: io.bucket,
      prefix: input.prefix,
      now,
      uploads: io.uploads,
    });
    const stores = await openCloudflareStorage({ ...input, bucket: io.bucket });
    const cache = cacheObjects(stores.objects, input.cacheBytes ?? 8 * 1024 * 1024),
      usage = treeUsage(input.storage, cache.objects, attachments);
    for (const pending of quota.pending(input.prefix))
      quota.finish(pending.id, (await stores.refs.receipt(pending.operation))?.state === "landed");
    const refs: RefStore = {
      ...stores.refs,
      async publish(transaction) {
        io.assertWriteAvailable();
        if (transaction.receipt.state !== "landed") return stores.refs.publish(transaction);
        const prior = await stores.refs.receipt(transaction.operation, transaction.fingerprint);
        if (prior) return { applied: true, receipt: prior };
        const current = await usage.at(transaction.receipt.previous),
          next = await usage.at(transaction.receipt.oid);
        const id = quota.reserve(
          input.prefix,
          transaction.operation,
          transaction.fingerprint,
          next.bytes - current.bytes,
          next.files - current.files,
        );
        const result = await stores.refs.publish(transaction);
        quota.finish(id, result.applied);
        return result;
      },
    };
    const sql = input.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS vault_authors(operation TEXT PRIMARY KEY, timestamp INTEGER NOT NULL,durable INTEGER NOT NULL DEFAULT 0)",
    );
    const author = async (operation: string) => {
      const row = [
        ...sql.exec("SELECT timestamp,durable FROM vault_authors WHERE operation=?", operation),
      ][0];
      if (row && typeof row.timestamp === "number" && row.durable === 1) return row.timestamp;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(operation));
      const key =
        input.prefix +
        "operations/" +
        [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("") +
        ".json";
      const saved = await io.bucket.get(key);
      let recovered: unknown;
      if (saved) {
        const value: unknown = JSON.parse(new TextDecoder().decode(await saved.arrayBuffer()));
        if (typeof value !== "object" || value === null || !("timestamp" in value))
          throw new Error("Invalid durable operation metadata");
        recovered = value.timestamp;
      }
      const timestamp = saved ? recovered : (row?.timestamp ?? Math.floor(now() / 1000));
      if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0)
        throw new Error("Invalid durable operation timestamp");
      sql.exec(
        "INSERT OR IGNORE INTO vault_authors(operation,timestamp) VALUES(?,?)",
        operation,
        timestamp,
      );
      const actual = [
        ...sql.exec("SELECT timestamp,durable FROM vault_authors WHERE operation=?", operation),
      ][0]?.timestamp;
      if (typeof actual !== "number") throw new Error("Missing durable operation timestamp");
      if (saved && actual !== timestamp) throw new Error("Durable operation timestamp changed");
      if (!saved) await io.bucket.put(key, JSON.stringify({ timestamp: actual }));
      sql.exec("UPDATE vault_authors SET durable=1 WHERE operation=?", operation);
      return actual;
    };
    const make = (timestamp: number) =>
      createDrive({
        objects: usage.objects,
        refs,
        author: { name: "Basalt", email: "drive@example.invalid", timestamp, timezoneOffset: 0 },
      });
    const reader = make(0);
    const drive: Drive = {
      ...reader,
      initialize: async (op) => make(await author(op)).initialize(op),
      openWriter: async (request) => make(await author(request.operation)).openWriter(request),
      commit: async (request) => make(await author(request.operation)).commit(request),
      land: async (request) => make(await author(request.operation)).land(request),
      resolve: async (request) => make(await author(request.operation)).resolve(request),
    };
    const root = await drive.initialize("initialize");
    const changes = createChangeReader(cache.objects),
      service = createDriveService(drive, attachments, changes, root);
    const scope = operationScope(drive, service, attachments, io.run);
    return {
      drive: scope.drive,
      attachments: scope.attachments,
      changes: scope.protect(changes),
      imports: importService({ manifest, service, attachments, run: io.run }),
      root,
      service: scope.service,
      clearCaches: async () => {
        cache.clear();
        usage.clear();
      },
      status: async () => ({ ...quota.status(), ...io.status(), limits, cache: cache.status() }),
    };
  }, manifest.active());
}
