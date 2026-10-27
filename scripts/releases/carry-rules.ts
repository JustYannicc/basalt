// Rules for what a carried-patch change touches, derived from where the pinned upstream keeps its
// database and Workflow code. They judge a changed file's paths and changed lines, so they may
// over-match but must not miss. Durable Object storage counts as database state.
import { isDatabasePath, workflowPath } from "./paths.ts";

export type AreaRules = {
  /** Display name in evidence reasons. */
  name: string;
  isPath(path: string): boolean;
  isCode(line: string): boolean;
  /** Dependencies whose version change counts as a change in this area. */
  packages: RegExp;
  /** Whether a template literal holding a changed line is judged as a whole. */
  templates: boolean;
};

const databasePath = new RegExp([
  // Migrations, schemas, SQL, database clients and roles.
  String.raw`(^|/)[^/]*(?:migrat|schema|database|fumadb|planetscale|hyperdrive|postgres|pglite|sqlite|drizzle|prisma)[^/]*(/|$)`,
  String.raw`(^|/)sql(/|\.[^/]+$)`,
  String.raw`(^|[/_.-])roles?([/_.-]|$)`,
  // Better Auth options decide the auth tables its migrator creates.
  String.raw`(^|/)[^/]*(?:auth-options|better-auth)[^/]*(/|$)`,
  // Durable Object storage: app data facets, durable declarations and storage modules.
  String.raw`(^|/)[^/]*(?:durable|facet|app-data)[^/]*(/|$)`,
  String.raw`(^|[/_.-])storage([/_.-]|$)`,
].join("|"), "i");

const sqlTypes = String.raw`(?:text|varchar|char|character(?:\s+varying)?|citext|integer|int[248]?|bigint|smallint|boolean|bool|timestamptz|timestamp|timetz|time|date|interval|jsonb|json|uuid|bytea|numeric|decimal|serial|bigserial|smallserial|real|double\s+precision|float[48]|money|inet|cidr|macaddr|tsvector|tsquery|xml|oid|regclass)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+with(?:out)?\s+time\s+zone)?(?:\[\])?`;

const databaseCode = [
  /migrat/i,
  // DDL, including statements whose object kind or name is interpolated.
  /\b(?:create|alter|drop|truncate)\s+(?:(?:or\s+replace|unique|temp|temporary|unlogged|materialized|if\s+(?:not\s+)?exists|concurrently)\s+)*(?:table|index|schema|role|user|group|type|extension|trigger|function|procedure|view|sequence|policy|database|domain|\$\{)/i,
  /\b(?:add|drop|alter|rename)\s+(?:column|constraint)\b/i,
  /\bas\s+enum\b/i,
  // Privileges, role membership and ownership.
  // A statement-leading GRANT/REVOKE of anything to or from anyone, such as role membership.
  /(?:^|[`"';(])\s*(?:grant|revoke)\s+\S.*\b(?:to|from)\b/i,
  /\b(?:grant|revoke)\s+(?:all|select|insert|update|delete|usage|create|connect|execute|references|trigger|truncate|temp|temporary|maintain)\b/i,
  /\b(?:grant|revoke)\s+"?pg_\w+/i,
  /\b(?:reassign|drop)\s+owned\b|\bowner\s+to\b/i,
  /\b(?:pg_roles|pg_authid|rolname|pg_read_all_data|pg_write_all_data|search_path|information_schema|pg_catalog|schema_migration|session\s+authorization|set\s+role)\b/i,
  /-c\s+role=/i,
  /\b(?:PostgresRole|inheritedRoles|planetscale|hyperdrive|DATABASE_URL|DatabaseUrl|fumadb)/i,
  // Column, constraint and index fragments that sit far from their statement's keyword.
  new RegExp(String.raw`^\s*"?[a-z_][a-z0-9_]*"?\s+${sqlTypes}\s*(?:,|\)|$|(?:not\s+null|null|primary|references|default|unique|check|generated|collate)\b)`, "i"),
  /^\s*"?[a-z_][a-z0-9_]*"?\s+"?[a-z_][a-z0-9_.]*"?(?:\[\])?\s+(?:not\s+null|null|primary\s+key|references|default|unique|check|generated|collate)\b/i,
  /^\s*"?[a-z_][a-z0-9_]*"?\s+[a-z][a-z0-9]*_[a-z0-9_]*(?:\[\])?\s*,?\s*$/,
  /^\s*[a-z][a-z0-9]*_[a-z0-9_]*(?:\s+(?:asc|desc))?(?:\s+nulls\s+(?:first|last))?\s*[,)]*\s*$/,
  /\b(?:primary\s+key|foreign\s+key|references\s+"?\w+"?\s*\()/i,
  /\bis\s+(?:not\s+)?null\b|\bnot\s+null\b|\bon\s+(?:delete|update)\s+(?:cascade|restrict|set|no)\b/i,
  // `.check(` and friends are method calls, such as Effect Schema checks.
  /(?<!\.)\b(?:check|unique|include)\s*\(|\bwith\s*\(\s*\w+\s*=|\busing\s+(?:btree|gin|gist|hash|brin|spgist)\b|\bnulls\s+(?:first|last)\b/i,
  /\bgenerated\s+(?:always|by\s+default)\b|\bdefault\s+(?:now\(\)|gen_random_uuid|current_timestamp|true|false|null|'|\d)/i,
  // fumadb table definitions.
  /\b(?:idColumn|column|table)\s*\(\s*["'`]/,
  /\bschema\s*\(\s*\{/,
  // Better Auth options, whose plugins and fields its migrator turns into tables.
  /\bbetterAuth\s*\(|\bBetterAuthOptions\b|\bgetMigrations\b|\bplugins\s*:|\badditionalFields\b|\borganization\s*\(|\bteams\s*:\s*\{|\btwoFactor\s*\(/,
  // Durable Object storage identity: classes, names, keys, jurisdiction and migrations.
  /\bfacets\.(?:get|abort|delete)\s*\(|\bDurableObject\b|\btransferredFrom\b|\bgetByName\s*\(|\bidFrom(?:Name|String)\s*\(|\bnewUniqueId\s*\(|\bjurisdiction\b/,
  /\b(?:new_sqlite_classes|new_classes|deleted_classes|renamed_classes|transferred_classes|durable_objects)\b|\b(?:ctx|state)\.storage\b|\bstorage\.sql\b/,
];

const workflowCode = [
  /workflow/i,
  /\bstep\.\w+\s*\(/,
  /waitForEvent|sleepUntil|NonRetryableError/,
  /\.task\s*\(/,
  /(?<!\bEffect)\.sleep\s*\(/,
  // The Worker hosting a Workflow, its stack and the physical names derived from them.
  /\bextends\s+Cloudflare\.\w+\s*<|\bCloudflare\.Worker\s*[(<]/,
  /\bAlchemy\.Stack\b|\bStack\s*\(|\bstackName\b|\bALCHEMY_STACK_NAME\b/,
  /physicalName/i,
  // `className:` names a binding's class; JSX `className=` does not.
  /\b(?:scriptName|workerName)\b|\bclassName\s*:/,
];

// alchemy provisions both the Workflow hosts and the PlanetScale database.
const infrastructurePackages = String.raw`\balchemy\b|@alchemy\.run/|@distilled\.cloud/`;

export const databaseRules: AreaRules = {
  name: "database",
  isPath: (path) => isDatabasePath(path) || databasePath.test(path),
  isCode: (line) => databaseCode.some((rule) => rule.test(line)),
  packages: new RegExp(String.raw`better-auth|@effect/sql|(?:^|["'\s/])pg(?:["'\s:@]|$)|\bpg-|postgres|fumadb|kysely|drizzle|pglite|@electric-sql/|${infrastructurePackages}`),
  templates: true,
};

export const workflowRules: AreaRules = {
  name: "Workflow",
  isPath: (path) => workflowPath.test(path) || /physical-?name/i.test(path),
  isCode: (line) => workflowCode.some((rule) => rule.test(line)),
  packages: new RegExp(String.raw`cloudflare|wrangler|miniflare|workerd|${infrastructurePackages}`),
  templates: false,
};

const dependencyFile = /(^|\/)(?:bun\.lockb?|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|package\.json|pnpm-workspace\.yaml|bunfig\.toml|\.npmrc)$/;

/**
 * Whether `path` decides which dependency versions are installed. Any changed line in it may move
 * a dependency, even one written as `latest`, a catalog entry or a patch selector, so all count.
 */
export function isDependencyFile(path: string): boolean {
  return dependencyFile.test(path);
}
