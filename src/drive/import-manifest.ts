import { Schema } from "effect";
import { DriveImportPlan, type DriveImportEntry } from "apps/contracts";
import { DriveError, sha256, type TransactionStorage } from "./shared/index.ts";
import { QuotaExceeded, type QuotaLimits } from "./quota-limits.ts";
import type { importBudget } from "./import-budget.ts";

export function importManifest(
  storage: TransactionStorage,
  prefix: string,
  limits: QuotaLimits,
  budget: ReturnType<typeof importBudget>,
) {
  const { sql } = storage;
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_initial_imports(prefix TEXT PRIMARY KEY,id TEXT NOT NULL,state TEXT NOT NULL,next_page INTEGER NOT NULL,manifest TEXT NOT NULL)",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_initial_import_pages(prefix TEXT NOT NULL,page INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(prefix,page))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_initial_import_entries(prefix TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER NOT NULL,hash TEXT NOT NULL,operation TEXT,confirmed INTEGER NOT NULL DEFAULT 0,omitted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(prefix,path))",
  );
  sql.exec(
    "CREATE TABLE IF NOT EXISTS vault_initial_import_uploads(prefix TEXT NOT NULL,upload TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(prefix,upload))",
  );
  const find = (id: string) => {
    const row = [
      ...sql.exec("SELECT * FROM vault_initial_imports WHERE prefix=? AND id=?", prefix, id),
    ][0];
    if (!row) throw new DriveError("missing", "Initial import not found for this vault");
    if (
      (row.state !== "planning" && row.state !== "ready" && row.state !== "complete") ||
      typeof row.next_page !== "number" ||
      typeof row.manifest !== "string"
    )
      throw new DriveError("integrity", "Invalid initial import manifest ledger");
    return { id, state: row.state, nextPage: row.next_page, manifest: row.manifest };
  };
  const counts = () => {
    const row = [
      ...sql.exec(
        "SELECT COUNT(*) files,COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(CASE WHEN kind='note' THEN 1 ELSE 0 END),0) notes,COALESCE(SUM(CASE WHEN kind='note' THEN bytes ELSE 0 END),0) note_bytes,COALESCE(SUM(CASE WHEN kind='attachment' THEN (bytes+1048575)/1048576 ELSE 0 END),0) parts,COALESCE(SUM(confirmed),0) confirmed FROM vault_initial_import_entries WHERE prefix=?",
        prefix,
      ),
    ][0];
    const number = (key: string) => {
      const value = row?.[key];
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        throw new DriveError("integrity", "Invalid initial import counts");
      return value;
    };
    return {
      files: number("files"),
      bytes: number("bytes"),
      notes: number("notes"),
      noteBytes: number("note_bytes"),
      parts: number("parts"),
      confirmed: number("confirmed"),
    };
  };
  const status = (id: string) => {
    const row = find(id),
      totals = counts();
    const money =
      row.state === "planning"
        ? {
            reserved: { classA: 0, classB: 0, readBytes: 0 },
            used: { classA: 0, classB: 0, readBytes: 0 },
            reservedCostMicros: 0,
            usedCostMicros: 0,
            expiresAt: 0,
          }
        : budget.status(prefix, id);
    const omitted = Number(
      [
        ...sql.exec(
          "SELECT COALESCE(SUM(omitted),0) count FROM vault_initial_import_entries WHERE prefix=?",
          prefix,
        ),
      ][0]?.count ?? 0,
    );
    return {
      ...row,
      files: totals.files,
      bytes: totals.bytes,
      confirmed: totals.confirmed,
      omitted,
      reserved: money.reserved,
      used: money.used,
      reservedCostMicros: money.reservedCostMicros,
      usedCostMicros: money.usedCostMicros,
      expiresAt: money.expiresAt,
    };
  };
  const ready = (id: string) => {
    if (find(id).state !== "ready")
      throw new DriveError("invalid", "Initial import manifest must be sealed and unfinished");
    budget.available(prefix, id);
  };
  return {
    status,
    ready,
    current() {
      const row = [...sql.exec("SELECT id FROM vault_initial_imports WHERE prefix=?", prefix)][0];
      if (!row) return null;
      if (typeof row.id !== "string")
        throw new DriveError("integrity", "Invalid initial import identity");
      return status(row.id);
    },
    active() {
      const row = [
        ...sql.exec(
          "SELECT id FROM vault_initial_imports WHERE prefix=? AND state='ready'",
          prefix,
        ),
      ][0];
      if (!row) return null;
      if (typeof row.id !== "string")
        throw new DriveError("integrity", "Invalid active initial import identity");
      return budget.isAvailable(prefix, row.id) ? row.id : null;
    },
    plan(input: typeof DriveImportPlan.Type) {
      const page = Schema.decodeUnknownSync(DriveImportPlan)(input, { onExcessProperty: "error" });
      const fingerprint = sha256(new TextEncoder().encode(JSON.stringify(page)));
      return storage.transactionSync(() => {
        const existing = [
          ...sql.exec("SELECT id FROM vault_initial_imports WHERE prefix=?", prefix),
        ][0];
        if (existing && existing.id !== page.id)
          throw new DriveError("invalid", "Only one initial import is allowed for this vault");
        if (!existing) {
          if (page.page !== 0)
            throw new DriveError("invalid", "Initial import starts at manifest page zero");
          sql.exec(
            "INSERT INTO vault_initial_imports VALUES(?,?,'planning',0,'')",
            prefix,
            page.id,
          );
        }
        const old = [
          ...sql.exec(
            "SELECT fingerprint FROM vault_initial_import_pages WHERE prefix=? AND page=?",
            prefix,
            page.page,
          ),
        ][0];
        if (old) {
          if (old.fingerprint !== fingerprint)
            throw new DriveError(
              "invalid",
              "An import manifest page cannot identify different files",
            );
          return status(page.id);
        }
        const row = find(page.id);
        if (
          row.state === "complete" ||
          row.nextPage !== page.page ||
          (row.state === "ready" && !page.final)
        )
          throw new DriveError(
            "invalid",
            "Initial import manifest page is out of order or already complete",
          );
        for (const entry of page.entries) {
          if (
            !entry.path ||
            entry.path.includes("\\") ||
            entry.path.includes("\0") ||
            entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
            entry.path.split("/").length > 32 ||
            entry.hash.length !== (entry.kind === "note" ? 40 : 64)
          )
            throw new DriveError("invalid", "Invalid initial import manifest file");
          const prior = [
            ...sql.exec(
              "SELECT operation,omitted FROM vault_initial_import_entries WHERE prefix=? AND path=?",
              prefix,
              entry.path,
            ),
          ][0];
          if (prior && (row.state !== "ready" || prior.operation !== null || prior.omitted === 1))
            throw new DriveError(
              "invalid",
              "Initial import manifest repeats or changes an already claimed file",
            );
          sql.exec(
            "INSERT INTO vault_initial_import_entries(prefix,path,kind,bytes,hash) VALUES(?,?,?,?,?) ON CONFLICT(prefix,path) DO UPDATE SET kind=excluded.kind,bytes=excluded.bytes,hash=excluded.hash",
            prefix,
            entry.path,
            entry.kind,
            entry.bytes,
            entry.hash,
          );
        }
        if (page.removed?.length && row.state !== "ready")
          throw new DriveError(
            "invalid",
            "Only a sealed initial import can record a removed source file",
          );
        for (const path of page.removed ?? []) {
          const item = [
            ...sql.exec(
              "SELECT operation,omitted FROM vault_initial_import_entries WHERE prefix=? AND path=?",
              prefix,
              path,
            ),
          ][0];
          if (!item || item.operation !== null || item.omitted === 1)
            throw new DriveError(
              "invalid",
              "Removed source file is missing or already claimed by an import operation",
            );
          sql.exec(
            "UPDATE vault_initial_import_entries SET omitted=1,confirmed=1 WHERE prefix=? AND path=?",
            prefix,
            path,
          );
        }
        const totals = counts();
        if (totals.files > limits.files)
          throw new QuotaExceeded("files", totals.files, limits.files);
        if (totals.bytes > limits.currentBytes)
          throw new QuotaExceeded("currentBytes", totals.bytes, limits.currentBytes);
        if (page.final) budget.reserve(prefix, page.id, totals);
        sql.exec(
          "INSERT INTO vault_initial_import_pages VALUES(?,?,?)",
          prefix,
          page.page,
          fingerprint,
        );
        sql.exec(
          "UPDATE vault_initial_imports SET next_page=next_page+1,manifest=?,state=? WHERE prefix=?",
          sha256(new TextEncoder().encode(row.manifest + fingerprint)),
          page.final ? "ready" : "planning",
          prefix,
        );
        return status(page.id);
      });
    },
    claim(id: string, operation: string, entries: readonly DriveImportEntry[]) {
      ready(id);
      storage.transactionSync(() => {
        for (const entry of entries) {
          const row = [
            ...sql.exec(
              "SELECT * FROM vault_initial_import_entries WHERE prefix=? AND path=?",
              prefix,
              entry.path,
            ),
          ][0];
          if (
            !row ||
            row.omitted === 1 ||
            row.kind !== entry.kind ||
            row.bytes !== entry.bytes ||
            row.hash !== entry.hash ||
            (row.operation !== null && row.operation !== operation)
          )
            throw new DriveError(
              "invalid",
              "Initial import operation differs from its declared file manifest",
            );
          sql.exec(
            "UPDATE vault_initial_import_entries SET operation=? WHERE prefix=? AND path=?",
            operation,
            prefix,
            entry.path,
          );
        }
      });
    },
    confirm(operation: string) {
      sql.exec(
        "UPDATE vault_initial_import_entries SET confirmed=1 WHERE prefix=? AND operation=?",
        prefix,
        operation,
      );
    },
    operation(id: string, operation: string) {
      ready(id);
      if (
        ![
          ...sql.exec(
            "SELECT path FROM vault_initial_import_entries WHERE prefix=? AND operation=? LIMIT 1",
            prefix,
            operation,
          ),
        ][0]
      )
        throw new DriveError("invalid", "Operation is not part of this initial import manifest");
    },
    beginUpload(id: string, operation: string, hash: string, bytes: number) {
      ready(id);
      const upload = sha256(new TextEncoder().encode(operation));
      const previous = [
        ...sql.exec(
          "SELECT hash,bytes FROM vault_initial_import_uploads WHERE prefix=? AND upload=?",
          prefix,
          upload,
        ),
      ][0];
      if (previous && (previous.hash !== hash || previous.bytes !== bytes))
        throw new DriveError("invalid", "Initial import upload operation changed its bytes");
      if (
        !previous &&
        ![
          ...sql.exec(
            "SELECT path FROM vault_initial_import_entries WHERE prefix=? AND kind='attachment' AND hash=? AND bytes=? LIMIT 1",
            prefix,
            hash,
            bytes,
          ),
        ][0]
      )
        throw new DriveError("invalid", "Attachment is not in the initial import manifest");
      sql.exec(
        "INSERT OR IGNORE INTO vault_initial_import_uploads VALUES(?,?,?,?)",
        prefix,
        upload,
        hash,
        bytes,
      );
    },
    upload(id: string, upload: string) {
      ready(id);
      if (
        ![
          ...sql.exec(
            "SELECT upload FROM vault_initial_import_uploads WHERE prefix=? AND upload=?",
            prefix,
            upload,
          ),
        ][0]
      )
        throw new DriveError("invalid", "Upload is not part of this initial import manifest");
    },
    finish(id: string) {
      const row = find(id);
      if (row.state === "complete") return status(id);
      if (row.state !== "ready")
        throw new DriveError("invalid", "Initial import manifest must be sealed");
      const totals = counts();
      if (totals.files !== totals.confirmed)
        throw new DriveError("invalid", "Initial import still has unconfirmed manifest files");
      storage.transactionSync(() => {
        sql.exec(
          "UPDATE vault_initial_imports SET state='complete' WHERE prefix=? AND id=?",
          prefix,
          id,
        );
        budget.close(prefix, id);
      });
      return status(id);
    },
  };
}
