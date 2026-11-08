import { DriveError, type TransactionStorage } from "./shared/index.ts";
import { QuotaExceeded } from "./quota-limits.ts";

export interface ImportPolicy {
  /** USD millionths per million operations. Standard R2, https://developers.cloudflare.com/r2/pricing/ */
  classAPrice: number;
  classBPrice: number;
  accountCostMicros: number;
  lifetimeMs: number;
}
export const defaultImportPolicy: ImportPolicy = {
  classAPrice: 4_500_000,
  classBPrice: 360_000,
  accountCostMicros: 1_000_000,
  lifetimeMs: 30 * 24 * 60 * 60 * 1000,
};
export function importBudget(
  storage: TransactionStorage,
  now: () => number,
  overrides: Partial<ImportPolicy> = {},
) {
  const policy = { ...defaultImportPolicy, ...overrides },
    { sql } = storage;
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new DriveError(
      "invalid",
      "Initial import prices and limits must be nonnegative safe integers",
    );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_initial_import_budget(prefix TEXT PRIMARY KEY,id TEXT NOT NULL,a_limit INTEGER NOT NULL,b_limit INTEGER NOT NULL,read_limit INTEGER NOT NULL,a_used INTEGER NOT NULL,b_used INTEGER NOT NULL,read_used INTEGER NOT NULL,price_a INTEGER NOT NULL,price_b INTEGER NOT NULL,cost INTEGER NOT NULL,used_cost INTEGER NOT NULL,expires INTEGER NOT NULL,closed INTEGER NOT NULL)",
  );
  const row = (prefix: string, id: string) => {
    const value = [
      ...sql.exec("SELECT * FROM vault_initial_import_budget WHERE prefix=? AND id=?", prefix, id),
    ][0];
    if (!value) throw new DriveError("missing", "Initial import reservation not found");
    const number = (key: string) => {
      const result = value[key];
      if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
        throw new DriveError("integrity", "Invalid initial import cost ledger");
      return result;
    };
    return {
      reserved: {
        classA: number("a_limit"),
        classB: number("b_limit"),
        readBytes: number("read_limit"),
      },
      used: { classA: number("a_used"), classB: number("b_used"), readBytes: number("read_used") },
      reservedCostMicros: number("cost"),
      usedCostMicros: number("used_cost"),
      expiresAt: number("expires"),
      priceA: number("price_a"),
      priceB: number("price_b"),
      closed: number("closed"),
    };
  };
  const cost = (a: number, b: number, priceA = policy.classAPrice, priceB = policy.classBPrice) =>
    Math.ceil((a * priceA + b * priceB) / 1_000_000);
  return {
    status: row,
    reserve(
      prefix: string,
      id: string,
      counts: { files: number; notes: number; noteBytes: number; bytes: number; parts: number },
    ) {
      const old = [
        ...sql.exec("SELECT id FROM vault_initial_import_budget WHERE prefix=?", prefix),
      ][0];
      if (old && old.id !== id)
        throw new DriveError("invalid", "Initial import reservation identity changed");
      const prior = old ? row(prefix, id) : null;
      if (prior?.closed) throw new DriveError("invalid", "This initial import is already complete");
      const a = Math.max(
        prior?.reserved.classA ?? 0,
        128 +
          Math.ceil(counts.noteBytes / (2 * 1048576)) * 12 +
          Math.ceil(counts.files / 100) * 12 +
          (counts.files - counts.notes) * 3 +
          counts.parts * 2,
      );
      const b = Math.max(
        prior?.reserved.classB ?? 0,
        256 + a * 8 + counts.files * 4 + counts.parts * 8,
      );
      const estimate = cost(
        a,
        b,
        prior?.priceA ?? policy.classAPrice,
        prior?.priceB ?? policy.classBPrice,
      );
      const used = Number(
        [
          ...sql.exec(
            "SELECT COALESCE(SUM(CASE WHEN closed=0 AND expires>? THEN cost ELSE used_cost END),0) cost FROM vault_initial_import_budget WHERE prefix<>?",
            now(),
            prefix,
          ),
        ][0]?.cost ?? 0,
      );
      if (used + estimate > policy.accountCostMicros)
        throw new QuotaExceeded("initialImport.costMicros", used, policy.accountCostMicros);
      sql.exec(
        "INSERT INTO vault_initial_import_budget VALUES(?,?,?,?,?,0,0,0,?,?,?,0,?,0) ON CONFLICT(prefix) DO UPDATE SET a_limit=excluded.a_limit,b_limit=excluded.b_limit,read_limit=MAX(read_limit,excluded.read_limit),cost=excluded.cost,expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END",
        prefix,
        id,
        a,
        b,
        counts.bytes * 4 + counts.files * 8192 + 1048576,
        prior?.priceA ?? policy.classAPrice,
        prior?.priceB ?? policy.classBPrice,
        estimate,
        now() + policy.lifetimeMs,
        now(),
      );
      return row(prefix, id);
    },
    available(prefix: string, id: string) {
      const value = row(prefix, id);
      if (value.closed) throw new DriveError("invalid", "This initial import is already complete");
      if (value.expiresAt <= now())
        throw new DriveError(
          "capacity",
          `Initial import ${id} expired at ${new Date(value.expiresAt).toISOString()}; its files and counted usage are retained`,
        );
      return value;
    },
    isAvailable(prefix: string, id: string) {
      const value = row(prefix, id);
      return !value.closed && value.expiresAt > now();
    },
    charge(prefix: string, id: string, a: number, b: number, bytes: number) {
      const value = this.available(prefix, id);
      for (const [resource, extra] of [
        ["classA", a],
        ["classB", b],
        ["readBytes", bytes],
      ] as const)
        if (value.used[resource] + extra > value.reserved[resource])
          throw new QuotaExceeded(
            `initialImport.${resource}`,
            value.used[resource],
            value.reserved[resource],
          );
      const classA = value.used.classA + a,
        classB = value.used.classB + b;
      sql.exec(
        "UPDATE vault_initial_import_budget SET a_used=?,b_used=?,read_used=read_used+?,used_cost=? WHERE prefix=? AND id=?",
        classA,
        classB,
        bytes,
        cost(classA, classB, value.priceA, value.priceB),
        prefix,
        id,
      );
    },
    close(prefix: string, id: string) {
      sql.exec(
        "UPDATE vault_initial_import_budget SET closed=1 WHERE prefix=? AND id=?",
        prefix,
        id,
      );
    },
  };
}
