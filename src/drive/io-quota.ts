import { uploadBudget } from "./upload-budget.ts";
import { importBudget, type ImportPolicy } from "./import-budget.ts";
import { Cause, Data, Effect, Exit, Semaphore } from "effect";
import { DriveError, type Bucket, type TransactionStorage } from "./shared/index.ts";
import { QuotaExceeded, type QuotaLimits } from "./quota-limits.ts";
class VaultOperationFailed extends Data.TaggedError("VaultOperationFailed")<{ cause: unknown }> {}

/** This ledger survives disposable cache loss. An uncertain PUT keeps its reservation. */
export function meteredBucket(input: {
  storage: TransactionStorage;
  bucket: Bucket & { delete?(key: string): Promise<unknown> };
  limits: QuotaLimits;
  now: () => number;
  prefix: string;
  importPolicy?: Partial<ImportPolicy>;
}) {
  const { storage, bucket, limits, now } = input,
    { sql } = storage;
  const imports = importBudget(storage, now, input.importPolicy),
    semaphore = Semaphore.makeUnsafe(1);
  let importId: string | null = null;
  const run = async <T>(use: () => Promise<T>, id: string | null = null): Promise<T> => {
    const result = await Effect.runPromiseExit(
      semaphore.withPermit(
        Effect.tryPromise({
          try: async () => {
            importId = id;
            try {
              return await use();
            } finally {
              importId = null;
            }
          },
          catch: (cause) => new VaultOperationFailed({ cause }),
        }),
      ),
    );
    if (Exit.isSuccess(result)) return result.value;
    const failure = Cause.squash(result.cause);
    throw failure instanceof VaultOperationFailed ? failure.cause : failure;
  };
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_stored_objects(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL, state TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_io(period TEXT PRIMARY KEY, class_a INTEGER NOT NULL, class_b INTEGER NOT NULL, read_bytes INTEGER NOT NULL)",
  );
  const period = () => {
    const date = new Date(now());
    return {
      id: date.toISOString().slice(0, 7),
      resetAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(),
    };
  };
  const usage = () => {
    const month = period();
    sql.exec("INSERT OR IGNORE INTO vault_io VALUES(?,0,0,0)", month.id);
    const row = [...sql.exec("SELECT * FROM vault_io WHERE period=?", month.id)][0];
    if (
      !row ||
      ![row.class_a, row.class_b, row.read_bytes].every(
        (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new DriveError("integrity", "Invalid R2 operation ledger");
    return {
      classA: Number(row.class_a),
      classB: Number(row.class_b),
      readBytes: Number(row.read_bytes),
      ...month,
    };
  };
  const stored = () => {
    const row = [
      ...sql.exec(
        "SELECT COALESCE(SUM(CASE WHEN state='stored' THEN bytes ELSE 0 END),0) stored, COALESCE(SUM(CASE WHEN state='pending' THEN bytes ELSE 0 END),0) pending FROM vault_stored_objects",
      ),
    ][0];
    if (!row || typeof row.stored !== "number" || typeof row.pending !== "number")
      throw new DriveError("integrity", "Invalid retained storage ledger");
    return { retainedBytes: row.stored, reservedStorageBytes: row.pending };
  };
  const uploads = uploadBudget(storage, limits, () => {
    const value = stored();
    return value.retainedBytes + value.reservedStorageBytes;
  });
  const retained = () => {
    const value = stored();
    return { ...value, reservedStorageBytes: value.reservedStorageBytes + uploads.remaining() };
  };
  const charge = (a: number, b: number, bytes = 0) => {
    if (importId) {
      imports.charge(input.prefix, importId, a, b, bytes);
      return;
    }
    const used = usage();
    for (const [resource, extra] of [
      ["classA", a],
      ["classB", b],
      ["readBytes", bytes],
    ] as const)
      if (used[resource] + extra > limits[resource])
        throw new QuotaExceeded(resource, used[resource], limits[resource], used.resetAt);
    sql.exec(
      "UPDATE vault_io SET class_a=class_a+?,class_b=class_b+?,read_bytes=read_bytes+? WHERE period=?",
      a,
      b,
      bytes,
      used.id,
    );
  };
  const admit = (a: number, b: number, bytes = 0) =>
    storage.transactionSync(() => charge(a, b, bytes));
  const assertWriteAvailable = () => {
    if (importId) {
      const value = imports.available(input.prefix, importId);
      if (value.used.classA >= value.reserved.classA)
        throw new QuotaExceeded("initialImport.classA", value.used.classA, value.reserved.classA);
      return;
    }
    const used = usage();
    if (used.classA >= limits.classA)
      throw new QuotaExceeded("classA", used.classA, limits.classA, used.resetAt);
  };
  const measured: Bucket & { delete(key: string): Promise<void> } = {
    async delete(key) {
      if (!bucket.delete)
        throw new DriveError("invalid", "Attachment cleanup requires object deletion support");
      // Only the attachment service exposes deletion, after checking its accepted manifest.
      if (!/^[A-Za-z0-9_-]+\/attachments\/uploads\/[0-9a-f]{64}\/parts\/[0-9]{5}$/u.test(key))
        throw new DriveError("invalid", "Only abandoned attachment parts can be deleted");
      await bucket.delete(key);
      admit(0, 1);
      const retained = await bucket.get(key);
      if (retained) {
        await retained.body.cancel();
        throw new DriveError("integrity", "Attachment part deletion was not confirmed");
      }
      sql.exec("DELETE FROM vault_stored_objects WHERE key=?", key);
    },
    async put(key, value) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const fingerprint = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      storage.transactionSync(() => {
        charge(1, 0);
        const existing = [
          ...sql.exec("SELECT fingerprint,bytes FROM vault_stored_objects WHERE key=?", key),
        ][0];
        if (existing) {
          if (existing.fingerprint !== fingerprint || existing.bytes !== bytes.length)
            throw new DriveError(
              "integrity",
              "An immutable R2 key cannot identify different bytes",
            );
          return;
        }
        const used = retained();
        if (
          !uploads.draw(key, bytes.length) &&
          used.retainedBytes + used.reservedStorageBytes + bytes.length > limits.retainedBytes
        )
          throw new QuotaExceeded(
            "retainedBytes",
            used.retainedBytes + used.reservedStorageBytes,
            limits.retainedBytes,
          );
        sql.exec(
          "INSERT INTO vault_stored_objects VALUES(?,?,?,'pending')",
          key,
          fingerprint,
          bytes.length,
        );
      });
      await bucket.put(key, bytes);
      sql.exec("UPDATE vault_stored_objects SET state='stored' WHERE key=?", key);
    },
    async get(key, options) {
      admit(0, 1);
      const object = await bucket.get(key, options);
      if (object) {
        const bytes = options?.range
          ? Math.min(options.range.length, Math.max(0, object.size - options.range.offset))
          : object.size;
        // Charge the admitted body bound even if a caller leaves the response unread.
        admit(0, 0, bytes);
        const pending = [
          ...sql.exec(
            "SELECT fingerprint,bytes FROM vault_stored_objects WHERE key=? AND state='pending'",
            key,
          ),
        ][0];
        if (pending && !options?.range) {
          const recovered = new Uint8Array(await object.arrayBuffer());
          const digest = await crypto.subtle.digest("SHA-256", recovered);
          const fingerprint = [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
          if (pending.bytes !== recovered.length || pending.fingerprint !== fingerprint)
            throw new DriveError("integrity", "Recovered R2 bytes do not match their reservation");
          sql.exec("UPDATE vault_stored_objects SET state='stored' WHERE key=?", key);
          return {
            size: recovered.length,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(recovered);
                controller.close();
              },
            }),
            async arrayBuffer() {
              return recovered.buffer;
            },
          };
        }
      }
      return object;
    },
    async list(options) {
      admit(1, 0);
      return bucket.list(options);
    },
  };
  return {
    bucket: measured,
    uploads,
    imports,
    run,
    assertWriteAvailable,
    status: () => ({ ...usage(), ...retained() }),
  };
}
