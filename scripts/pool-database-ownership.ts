export interface OwnershipQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

export interface OwnershipQuerySession {
  query(text: string, values?: unknown[]): Promise<OwnershipQueryResult>;
}

export class HomeOwnershipAuthorityError extends Error {
  readonly _tag = "HomeOwnershipAuthorityError";
  readonly observedRole: string | undefined;
  constructor(observedRole: string | undefined) {
    super(
      `Home table ownership normalization refused: current_user ${JSON.stringify(observedRole ?? "unknown")} -> required "postgres"; only postgres may normalize Home trigger targets`,
    );
    this.observedRole = observedRole;
  }
}

export class HomeOwnershipScopeError extends Error {
  readonly _tag = "HomeOwnershipScopeError";
  readonly observedSchema: string | undefined;
  constructor(observedSchema: string | undefined) {
    super(
      `Home table ownership normalization refused: current_schema ${JSON.stringify(observedSchema ?? "unknown")} -> required "public"; Home trigger targets are limited to public`,
    );
    this.observedSchema = observedSchema;
  }
}

export class HomeTriggerTargetError extends Error {
  readonly _tag = "HomeTriggerTargetError";
  readonly relation: string;
  readonly reason: string;
  constructor(relation: string, reason: string) {
    super(
      `Home trigger target public.${JSON.stringify(relation)} -> required a supported table; ${reason}`,
    );
    this.relation = relation;
    this.reason = reason;
  }
}

export class UnexpectedHomeTableOwner extends Error {
  readonly _tag = "UnexpectedHomeTableOwner";
  readonly table: string;
  readonly owner: string;
  readonly blocked: readonly { table: string; owner: string }[];
  constructor(
    table: string,
    owner: string,
    others: readonly { table: string; owner: string }[] = [],
  ) {
    const blocked = [{ table, owner }, ...others];
    super(
      `Home trigger table ownership refused: ${blocked
        .map(
          (entry) =>
            `public.${JSON.stringify(entry.table)} owner ${JSON.stringify(entry.owner)} -> required "basalt_pool_owner"`,
        )
        .join("; ")}`,
    );
    this.blocked = blocked;
    this.table = table;
    this.owner = owner;
  }
}

export class HomeTriggerListError extends Error {
  readonly _tag = "HomeTriggerListError";
  constructor() {
    super("No Home change trigger targets were found in the migration statements");
  }
}

const closedIdentifier = /^[a-z_][a-z0-9_]{0,62}$/u;
const triggerPattern =
  /CREATE OR REPLACE TRIGGER basalt_pool_change_(?:write|delete)\s+(?:AFTER INSERT OR UPDATE|BEFORE DELETE) ON "([a-z_][a-z0-9_]*)" FOR EACH ROW/gu;

function quoteIdentifier(value: string): string {
  if (!closedIdentifier.test(value))
    throw new HomeTriggerTargetError(value, "identifier is outside the closed lowercase set");
  return `"${value}"`;
}

/** Extracts only targets actually named by the change trigger DDL in #0560. */
export function homeTriggerTargets(statements: readonly string[]): string[] {
  const targets = new Set<string>();
  for (const statement of statements) {
    for (const match of statement.matchAll(triggerPattern)) {
      const table = match[1];
      if (table !== undefined) targets.add(table);
    }
  }
  const result = [...targets].sort();
  if (result.length === 0) throw new HomeTriggerListError();
  return result;
}

/**
 * Transfers only existing, postgres-owned Home trigger targets to the established
 * schema owner. Call from the existing provisionOnce admin session before
 * migrateModelHistory. Every owner is checked before the first ALTER.
 */
export async function normalizeHomeTriggerTableOwners(
  session: OwnershipQuerySession,
  schemaOwner: "basalt_pool_owner",
  changeStatements: readonly string[],
): Promise<{ changed: string[]; alreadyOwned: string[]; missing: string[] }> {
  const targets = homeTriggerTargets(changeStatements);
  await session.query("BEGIN");
  try {
    await session.query("SET LOCAL lock_timeout = '500ms'");
    await session.query("SET LOCAL statement_timeout = '5s'");
    await session.query("SELECT pg_advisory_xact_lock(1409, 20)");

    const identity = await session.query(
      "SELECT current_user::text AS session_role, current_schema()::text AS schema_name",
    );
    const role = identity.rows[0]?.session_role;
    const schema = identity.rows[0]?.schema_name;
    if (typeof role !== "string" || role !== "postgres")
      throw new HomeOwnershipAuthorityError(typeof role === "string" ? role : undefined);
    if (typeof schema !== "string" || schema !== "public")
      throw new HomeOwnershipScopeError(typeof schema === "string" ? schema : undefined);

    const catalog = await session.query(
      `SELECT c.relname::text AS table_name, c.relkind::text AS relation_kind,
          r.rolname::text AS owner_name
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        JOIN pg_catalog.pg_roles AS r ON r.oid = c.relowner
        WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
        ORDER BY c.relname`,
      [targets],
    );

    const targetSet = new Set(targets);
    const existing = new Map<string, { kind: string; owner: string }>();
    const blocked: { table: string; owner: string }[] = [];
    for (const row of catalog.rows) {
      const table = row.table_name;
      const kind = row.relation_kind;
      const owner = row.owner_name;
      if (
        typeof table !== "string" ||
        !targetSet.has(table) ||
        typeof kind !== "string" ||
        typeof owner !== "string"
      )
        throw new HomeTriggerTargetError(String(table ?? "unknown"), "catalog row is malformed");
      if (kind !== "r" && kind !== "p")
        throw new HomeTriggerTargetError(table, "relation is not a table");
      if (owner !== "postgres" && owner !== schemaOwner) blocked.push({ table, owner });
      existing.set(table, { kind, owner });
    }

    const [first, ...others] = blocked;
    if (first) throw new UnexpectedHomeTableOwner(first.table, first.owner, others);

    const changed: string[] = [];
    const alreadyOwned: string[] = [];
    const missing = targets.filter((table) => !existing.has(table));
    for (const table of targets) {
      const row = existing.get(table);
      if (row === undefined) continue;
      if (row.owner === schemaOwner) {
        alreadyOwned.push(table);
        continue;
      }
      await session.query(
        `ALTER TABLE ${quoteIdentifier(schema)}.${quoteIdentifier(table)} OWNER TO ${quoteIdentifier(schemaOwner)}`,
      );
      changed.push(table);
    }

    await session.query("COMMIT");
    return { changed, alreadyOwned, missing };
  } catch (error) {
    await session.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
